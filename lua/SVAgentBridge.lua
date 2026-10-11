local bus,sourceDir = ...
assert(type(bus)=='string' and type(sourceDir)=='string','Install with scripts/install-bridge.mjs first')
bus=bus:gsub('/+$','')
local json=assert(loadfile(sourceDir..'/json.lua'))()
local engine=assert(loadfile(sourceDir..'/engine.lua'))(json)
local extension=assert(loadfile(sourceDir..'/extended.lua'))()
local api=engine.create(SV,extension)
local VERSION=1
local session,config,stopped,runtimeId
local function now() return os.time()*1000 end
local function safeId(id) return type(id)=='string' and #id>=1 and #id<=80 and not id:find('[^%w_-]') end
local function file(kind,id) assert(safeId(id),'Invalid request ID'); return bus..'/'..kind..'/'..id..'.json' end
local function exists(path) local f=io.open(path,'rb'); if not f then return false end; f:close(); return true end
local function read(path)
  local f=io.open(path,'rb'); if not f then return nil end
  local content=f:read(4*1024*1024+1); f:close()
  return json.decode(content or '')
end
local function atomic(path,value)
  local temp=path..'.'..(session and session.sessionId or 'startup')..'.tmp'
  local data=json.encode(value)
  local f=assert(io.open(temp,'wb')); assert(f:write(data)); assert(f:close())
  local ok,err=os.rename(temp,path)
  if not ok then os.remove(temp); error('Atomic rename failed: '..tostring(err)) end
end
local function publishSession(state,reason)
  session.state=state; session.heartbeatAt=now(); session.reason=reason
  atomic(bus..'/session.json',session)
end
local function stop(reason)
  stopped=true; publishSession('stopped',reason); SV:finish()
end
local function projectToken()
  local p=SV:getProject()
  if p:getNumTracks()==0 then return 'empty-project' end
  return p:getTrack(1):getGroupReference(1):getTarget():getUUID()
end
local function reply(id,ok,value)
  local result={protocolVersion=VERSION,id=id,sessionId=session.sessionId,ok=ok,completedAt=now()}
  if ok then result.result=value else result.error=value end
  return result
end
local function process(item)
  if type(item)~='table' or not safeId(item.id) then error('Invalid queue entry') end
  if item.sessionId~=session.sessionId or exists(file('replies',item.id)) then return end
  local id=item.id; local request; local ctx={mayHaveApplied=false}
  local ok,value=pcall(function()
    request=read(file('requests',id))
    if type(request)~='table' or request.protocolVersion~=VERSION or request.id~=id or request.sessionId~=session.sessionId then
      engine.fail('INVALID_REQUEST','Request ID, session or protocol mismatch')
    end
    if #json.encode(request)>512*1024 then engine.fail('REQUEST_TOO_LARGE','Request exceeds 512 KiB') end
    if request.projectFile~=session.projectFile then engine.fail('PROJECT_CHANGED','Request targets a different project') end
    if type(request.method)~='string' or type(request.params)~='table' or request.params==json.null or json.isArray(request.params) then
      engine.fail('INVALID_REQUEST','Invalid method or params')
    end
    local receipt=read(file('receipts',id))
    local fingerprint=json.encode(request)
    if receipt then
      if receipt.request~=fingerprint then engine.fail('REQUEST_ID_CONFLICT','Request payload changed after execution began') end
      if receipt.state=='completed' then return {cachedReply=receipt.reply} end
      ctx.mayHaveApplied=true
      engine.fail('INDETERMINATE','Execution was interrupted before a durable result. It will not be automatically repeated. Inspect the project or undo.')
    end
    if type(request.deadlineAt)~='number' then engine.fail('INVALID_REQUEST','deadlineAt is required') end
    -- Embedded os.time has second resolution. Reject conservatively within the last second.
    if now()+1000>=request.deadlineAt then engine.fail('REQUEST_EXPIRED','Request expired before execution') end
    if exists(file('cancellations',id)) then engine.fail('REQUEST_CANCELLED','Request cancelled before execution') end
    atomic(file('receipts',id),{id=id,sessionId=session.sessionId,state='executing',startedAt=now(),request=fingerprint})
    local result=api.execute(request.method,request.params,ctx)
    -- Intentional track changes can replace the first main group used as project identity.
    if request.method=='sv_create_track' or request.method=='sv_remove_track' then
      session.projectToken=projectToken(); publishSession('running')
    end
    return result
  end)
  local response
  if ok and type(value)=='table' and value.cachedReply then response=value.cachedReply
  elseif ok then response=reply(id,true,value)
  else
    local err=type(value)=='table' and value or {code='HOST_ERROR',message=tostring(value)}
    err.mayHaveApplied=ctx.mayHaveApplied
    response=reply(id,false,err)
  end
  if #json.encode(response)>2*1024*1024 then
    response=reply(id,false,{code='RESPONSE_TOO_LARGE',message='Result exceeds 2 MiB; use paginated reads',mayHaveApplied=ctx.mayHaveApplied})
  end
  -- Persist the completed result first; a failed reply write can then be retried without reapplying the edit.
  if request then
    atomic(file('receipts',id),{id=id,sessionId=session.sessionId,state='completed',request=json.encode(request),reply=response})
  end
  atomic(file('replies',id),response)
  if request and request.method=='sv_stop_bridge' and response.ok then stop('requested') end
end
local function tick()
  if stopped then return end
  local owner=read(bus..'/session.json')
  if not owner or owner.sessionId~=session.sessionId or owner.runtimeId~=runtimeId then stopped=true; return end
  if SV:getProject():getFileName()~=session.projectFile or projectToken()~=session.projectToken then stop('project_changed'); return end
  local ok,err=pcall(function()
    local index=read(bus..'/queue.json')
    if index then
      if index.protocolVersion~=VERSION or not json.isArray(index.entries) or #index.entries>256 then error('Invalid queue index') end
      local count=0; local started=os.clock()
      for _,item in ipairs(index.entries) do
        if type(item)=='table' and item.sessionId==session.sessionId and safeId(item.id) and not exists(file('replies',item.id)) then
          process(item); count=count+1
          if stopped or count>=config.maxPerTick or os.clock()-started>=0.05 then break end
        end
      end
    end
  end)
  if not ok then session.lastError=type(err)=='table' and err.message or tostring(err) end
  if stopped then return end
  if now()-session.heartbeatAt>=config.heartbeatMs then publishSession('running') end
  SV:setTimeout(config.pollMs,tick)
end
local function getClientInfo()
  return {name='SV Agent Bridge',author='Local agent bridge',versionNumber=1,minEditorVersion=131072}
end
local function main()
  local ok,err=pcall(function()
    config=assert(read(bus..'/bridge-config.json'),'Prepare the bus using the installer first')
    assert(config.protocolVersion==VERSION,'Unsupported configuration version')
    assert(type(config.pollMs)=='number' and config.pollMs>=20 and config.pollMs<=1000,'Invalid pollMs')
    assert(config.heartbeatMs==1000 and config.staleMs==6000,'Heartbeat configuration must match the MCP server')
    assert(type(config.maxPerTick)=='number' and config.maxPerTick%1==0 and config.maxPerTick>=1 and config.maxPerTick<=8,'Invalid maxPerTick')
    local prior=read(bus..'/session.json')
    local id=SV:create('NoteGroup'):getUUID()
    runtimeId=id
    if prior and prior.protocolVersion==VERSION and prior.state=='running' and type(prior.heartbeatAt)=='number'
      and now()-prior.heartbeatAt<config.staleMs and prior.projectFile==SV:getProject():getFileName() and prior.projectToken==projectToken() then
      -- Studio resets the execution environment on a second click. Resume the same session with a new runtime token.
      -- If a previous callback survives on another host, the runtime token fences it without cancelling the new loop.
      session=prior
    else
      session={protocolVersion=VERSION,sessionId=id,state='running',projectFile=SV:getProject():getFileName(),projectToken=projectToken(),host=SV:getHostInfo(),startedAt=now(),heartbeatAt=now(),pollMs=config.pollMs}
    end
    session.runtimeId=runtimeId
    assert(safeId(id),'Host UUID is not a valid file name')
    stopped=false; publishSession('running'); SV:setTimeout(config.pollMs,tick)
  end)
  if not ok then SV:showMessageBox('SV Agent Bridge',type(err)=='table' and err.message or tostring(err)); SV:finish() end
end
return {main=main,getClientInfo=getClientInfo}
