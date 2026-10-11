-- Structured Studio API operations. No request-supplied Lua is evaluated.
local json = ...
local M = {}
local MAX=9007199254740991
local parameters={'pitchDelta','vibratoEnv','loudness','tension','breathiness','voicing','gender','toneShift'}
function M.fail(code,message) error({code=code,message=message},0) end
local function check(ok,message) if not ok then M.fail('INVALID_ARGUMENT',message) end end
local function integer(v,min,max) return type(v)=='number' and v%1==0 and v>=min and v<=max end
local function stringField(v) return type(v)=='string' and #v<=16384 end
local function list(v,min,max)
  check(json.isArray(v) and #v>=min and #v<=max,'Invalid list length/type')
end
local function keys(v,allowed)
  check(type(v)=='table' and v~=json.null and not json.isArray(v),'Expected object')
  for k in pairs(v) do check(allowed[k], 'Unknown field: '..tostring(k)) end
end
local function hash(s)
  local a,b=2166136261,5381
  for i=1,#s do local n=s:byte(i); a=((a~n)*16777619)&0xffffffff; b=((b*33)~n)&0xffffffff end
  return string.format('r1:%08x%08x:%d',a,b,#s)
end
local function noteData(n)
  return {index=n:getIndexInParent(),onset=n:getOnset(),duration=n:getDuration(),pitch=n:getPitch(),lyrics=n:getLyrics(),phonemes=n:getPhonemes()}
end
local fields={onset=true,duration=true,pitch=true,lyrics=true,phonemes=true}
local setters={onset='setOnset',duration='setDuration',pitch='setPitch',lyrics='setLyrics',phonemes='setPhonemes'}
local function validateNote(patch,existing,full)
  keys(patch,fields)
  check(next(patch)~=nil,'Empty note patch')
  if full then for _,k in ipairs({'onset','duration','pitch','lyrics'}) do check(patch[k]~=nil,'Missing note field: '..k) end end
  if patch.onset~=nil then check(integer(patch.onset,0,MAX),'onset must be a nonnegative safe integer in blicks') end
  if patch.duration~=nil then check(integer(patch.duration,1,MAX),'duration must be a positive safe integer in blicks') end
  if patch.pitch~=nil then check(integer(patch.pitch,0,127),'pitch must be a MIDI integer, 0–127') end
  for _,k in ipairs({'lyrics','phonemes'}) do if patch[k]~=nil then check(stringField(patch[k]),k..' must be a string') end end
  check((patch.onset or (existing and existing:getOnset()) or 0)+(patch.duration or (existing and existing:getDuration()) or 1)<=MAX,'Note end exceeds safe integer range')
end
local function applyPatch(note,patch)
  -- Resolve object references before mutation: changing onsets can reorder the group.
  for _,k in ipairs({'duration','onset','pitch','lyrics','phonemes'}) do if patch[k]~=nil then note[setters[k]](note,patch[k]) end end
end
function M.create(SV,extension)
  local api={}
  local function project() return SV:getProject() end
  local function group(uuid)
    check(type(uuid)=='string' and #uuid>0 and #uuid<=80,'Invalid group UUID')
    local p=project()
    for ti=1,p:getNumTracks() do
      local t=p:getTrack(ti)
      for gi=1,t:getNumGroups() do local g=t:getGroupReference(gi):getTarget(); if g:getUUID()==uuid then return g end end
    end
    for i=1,p:getNumNoteGroupsInLibrary() do local g=p:getNoteGroup(i); if g:getUUID()==uuid then return g end end
    M.fail('GROUP_NOT_FOUND','No group with UUID '..uuid)
  end
  local function curve(g,name)
    local allowed=false; for _,k in ipairs(parameters) do if k==name then allowed=true end end
    check(allowed,'Unsupported parameter name')
    local ok,c=pcall(function() return g:getParameter(name) end)
    if not ok or not c then M.fail('UNSUPPORTED_PARAMETER','Host does not expose parameter '..name) end
    return c
  end
  local function state(g)
    if g:getNumNotes()>20000 then M.fail('LIMIT_EXCEEDED','Group exceeds 20000-note limit') end
    local notes=json.array()
    for i=1,g:getNumNotes() do notes[i]=noteData(g:getNote(i)) end
    local curves={}
    for _,name in ipairs(parameters) do
      local ok,points=pcall(function() return g:getParameter(name):getAllPoints() end)
      if ok then curves[name]=json.array(points) end
    end
    return {notes=notes,parameters=curves}
  end
  local function revision(g) return hash(json.encode(state(g))) end
  local function matchingGroup(p)
    local g=group(p.groupUuid)
    check(type(p.expectedRevision)=='string','expectedRevision is required')
    if revision(g)~=p.expectedRevision then M.fail('REVISION_CONFLICT','Group changed. Reread it before editing.') end
    return g
  end
  local function mutate(ctx,fn)
    project():newUndoRecord()
    ctx.mayHaveApplied=true
    return fn()
  end
  local function groupResult(g,count) return {groupUuid=g:getUUID(),revision=revision(g),noteCount=g:getNumNotes(),changed=count} end
  local function playback()
    local p=SV:getPlayback(); return {status=p:getStatus(),seconds=p:getPlayhead()}
  end
  local function trackUuid(t)
    for i=1,t:getNumGroups() do local ref=t:getGroupReference(i); if ref:isMain() then return ref:getTarget():getUUID() end end
    M.fail('HOST_ERROR','Track has no main group')
  end
  function api.sv_get_project_summary(p)
    keys(p,{})
    local proj=project(); local tracks=json.array(); local total=0
    for ti=1,proj:getNumTracks() do
      local t=proj:getTrack(ti); local groups=json.array(); local count=0
      for gi=1,t:getNumGroups() do
        local ref=t:getGroupReference(gi); local g=ref:getTarget(); count=count+g:getNumNotes()
        groups[gi]={referenceIndex=gi,groupUuid=g:getUUID(),name=g:getName(),noteCount=g:getNumNotes(),isMain=ref:isMain(),timeOffset=ref:getTimeOffset(),pitchOffset=ref:getPitchOffset()}
      end
      tracks[ti]={index=ti,trackUuid=trackUuid(t),name=t:getName(),noteCount=count,groups=groups}; total=total+count
    end
    local libraryGroups=json.array(); local libraryNotes=0
    for i=1,proj:getNumNoteGroupsInLibrary() do
      local g=proj:getNoteGroup(i)
      libraryGroups[i]={groupUuid=g:getUUID(),name=g:getName(),noteCount=g:getNumNotes()}; libraryNotes=libraryNotes+g:getNumNotes()
    end
    return {projectFile=proj:getFileName(),duration=proj:getDuration(),tracks=tracks,noteCount=total,libraryNoteCount=libraryNotes,libraryGroups=libraryGroups,
      tempo=json.array(proj:getTimeAxis():getAllTempoMarks()),meter=json.array(proj:getTimeAxis():getAllMeasureMarks()),playback=playback()}
  end
  function api.sv_read_project(p)
    local result=api.sv_get_project_summary(p)
    check(result.noteCount<=20000,'Snapshot exceeds 20000 notes; use paginated sv_get_notes')
    local groups={}; local uniqueNotes=0
    local function include(uuid)
      if not groups[uuid] then
        local g=group(uuid); uniqueNotes=uniqueNotes+g:getNumNotes()
        check(uniqueNotes<=20000,'Snapshot exceeds 20000 unique notes; use paginated sv_get_notes')
        local data=state(g); data.revision=hash(json.encode(data)); groups[uuid]=data
      end
    end
    for _,t in ipairs(result.tracks) do for _,ref in ipairs(t.groups) do
      include(ref.groupUuid)
    end end
    for _,g in ipairs(result.libraryGroups) do include(g.groupUuid) end
    result.groups=groups; return result
  end
  function api.sv_get_notes(p)
    keys(p,{groupUuid=true,startIndex=true,count=true}); local g=group(p.groupUuid)
    local start=p.startIndex or 1; local count=p.count or 500
    check(integer(start,1,MAX) and integer(count,1,2000),'Invalid pagination')
    local notes=json.array()
    for i=start,math.min(g:getNumNotes(),start+count-1) do notes[#notes+1]=noteData(g:getNote(i)) end
    return {groupUuid=g:getUUID(),name=g:getName(),revision=revision(g),total=g:getNumNotes(),startIndex=start,notes=notes}
  end
  function api.sv_get_selected_notes(p)
    keys(p,{}); local editor=SV:getMainEditor(); local ref=editor:getCurrentGroup(); local g=ref:getTarget(); local notes=json.array()
    for _,n in ipairs(editor:getSelection():getSelectedNotes()) do notes[#notes+1]=noteData(n) end
    table.sort(notes,function(a,b) return a.index<b.index end)
    return {groupUuid=g:getUUID(),revision=revision(g),timeOffset=ref:getTimeOffset(),pitchOffset=ref:getPitchOffset(),notes=notes}
  end
  function api.sv_update_notes(p,ctx)
    keys(p,{groupUuid=true,expectedRevision=true,updates=true}); local g=matchingGroup(p); list(p.updates,1,1000)
    local items,seen={},{}
    for _,u in ipairs(p.updates) do
      keys(u,{index=true,set=true}); check(integer(u.index,1,g:getNumNotes()) and not seen[u.index],'Invalid or duplicate note index')
      local n=g:getNote(u.index); validateNote(u.set,n,false); seen[u.index]=true; items[#items+1]={note=n,patch=u.set}
    end
    return mutate(ctx,function() for _,item in ipairs(items) do applyPatch(item.note,item.patch) end; return groupResult(g,#items) end)
  end
  function api.sv_add_notes(p,ctx)
    keys(p,{groupUuid=true,expectedRevision=true,notes=true}); local g=matchingGroup(p); list(p.notes,1,1000)
    check(g:getNumNotes()+#p.notes<=20000,'Group note limit exceeded')
    for _,n in ipairs(p.notes) do validateNote(n,nil,true) end
    return mutate(ctx,function()
      for _,data in ipairs(p.notes) do local n=SV:create('Note'); applyPatch(n,data); g:addNote(n) end
      return groupResult(g,#p.notes)
    end)
  end
  function api.sv_delete_notes(p,ctx)
    keys(p,{groupUuid=true,expectedRevision=true,indices=true}); local g=matchingGroup(p); list(p.indices,1,1000)
    local indices,seen={},{}
    for _,i in ipairs(p.indices) do check(integer(i,1,g:getNumNotes()) and not seen[i],'Invalid or duplicate note index'); seen[i]=true; indices[#indices+1]=i end
    table.sort(indices,function(a,b) return a>b end)
    return mutate(ctx,function() for _,i in ipairs(indices) do g:removeNote(i) end; return groupResult(g,#indices) end)
  end
  function api.sv_get_parameter_points(p)
    keys(p,{groupUuid=true,parameter=true}); local g=group(p.groupUuid); local c=curve(g,p.parameter)
    return {groupUuid=g:getUUID(),revision=revision(g),parameter=p.parameter,definition=c:getDefinition(),points=json.array(c:getAllPoints())}
  end
  function api.sv_set_parameter_points(p,ctx)
    keys(p,{groupUuid=true,expectedRevision=true,parameter=true,mode=true,points=true}); local g=matchingGroup(p); local c=curve(g,p.parameter)
    local mode=p.mode or 'replace'; check(mode=='replace' or mode=='merge','Invalid mode'); list(p.points,0,2000)
    local range=c:getDefinition().range; local seen={}
    for _,point in ipairs(p.points) do
      list(point,2,2); check(integer(point[1],0,MAX) and not seen[point[1]],'Invalid or duplicate control-point position'); seen[point[1]]=true
      check(type(point[2])=='number' and point[2]>=range[1] and point[2]<=range[2],'Control-point value outside host range')
    end
    return mutate(ctx,function()
      if mode=='replace' then c:removeAll() end
      for _,point in ipairs(p.points) do c:add(point[1],point[2]) end
      return {groupUuid=g:getUUID(),revision=revision(g),parameter=p.parameter,points=json.array(c:getAllPoints())}
    end)
  end
  function api.sv_rename_track(p,ctx)
    keys(p,{trackIndex=true,trackUuid=true,expectedName=true,name=true}); local proj=project()
    check(integer(p.trackIndex,1,proj:getNumTracks()) and stringField(p.name) and #p.name>0,'Invalid track index or name')
    local t=proj:getTrack(p.trackIndex)
    if t:getName()~=p.expectedName or trackUuid(t)~=p.trackUuid then M.fail('TRACK_CONFLICT','Track identity/name changed. Reread the summary.') end
    return mutate(ctx,function() t:setName(p.name); return {trackIndex=p.trackIndex,trackUuid=p.trackUuid,name=t:getName()} end)
  end
  function api.sv_playback(p)
    keys(p,{action=true,seconds=true}); local allowed={play=true,pause=true,stop=true,seek=true}; check(allowed[p.action],'Invalid playback action')
    local pb=SV:getPlayback()
    if p.action=='seek' then check(type(p.seconds)=='number' and p.seconds>=0 and p.seconds<=86400,'seek requires seconds'); pb:seek(p.seconds)
    else check(p.seconds==nil,'seconds applies only to seek'); pb[p.action](pb) end
    return playback()
  end
  function api.sv_stop_bridge(p) keys(p,{}); return {state='stopped'} end
  function api.execute(method,p,ctx)
    local fn=api[method]
    if not fn or method=='execute' then M.fail('UNKNOWN_METHOD','Unsupported operation '..tostring(method)) end
    return fn(p,ctx)
  end
  if extension then extension(api,{SV=SV,json=json,project=project,group=group,revision=revision,trackUuid=trackUuid,mutate=mutate,hash=hash,keys=keys,check=check,integer=integer,list=list,fail=M.fail}) end
  return api
end
return M
