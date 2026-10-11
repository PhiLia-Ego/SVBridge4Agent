local bus,sourceDir=arg[1],arg[2]
local json=assert(loadfile(sourceDir..'/json.lua'))()
for _,value in ipairs({'{}','[]','[false,null,0]','{"中文":"🎵\\n\\u0000","a":1.25e2}','"\\ud83c\\udfb5"'}) do
  local parsed=json.decode(value); assert(json.encode(json.decode(json.encode(parsed)))==json.encode(parsed))
end
for _,value in ipairs({'{','[1,]','{"x":1,}','{"x":1,"x":2}','01','1e','"\\ud800"','null garbage','"\n"','{"x" 1}'}) do
  assert(not pcall(json.decode,value),'Accepted invalid JSON: '..value)
end
assert(json.encode(json.array())=='[]' and json.encode({})=='{}')
assert(json.decode('false')==false)
local engine=assert(loadfile(sourceDir..'/engine.lua'))(json)
local group={notes={},curves={}}
local function newNote(pitch,onset)
  local n={pitch=pitch or 60,onset=onset or 0,duration=100,lyrics='无',phonemes=''}
  function n:getIndexInParent() for i,v in ipairs(group.notes) do if v==self then return i end end; return 0 end
  for _,k in ipairs({'pitch','onset','duration','lyrics','phonemes'}) do
    local upper=k:sub(1,1):upper()..k:sub(2)
    n['get'..upper]=function(self) return self[k] end
    n['set'..upper]=function(self,value) self[k]=value; if k=='onset' then table.sort(group.notes,function(a,b) return a.onset<b.onset end) end end
  end
  return n
end
group.notes={newNote(60,0),newNote(62,200)}
function group:getUUID() return 'group-uuid' end
function group:getName() return '测试组' end
function group:getNumNotes() return #self.notes end
function group:getNote(i) return assert(self.notes[i]) end
function group:addNote(n) self.notes[#self.notes+1]=n; table.sort(self.notes,function(a,b) return a.onset<b.onset end) end
function group:removeNote(i) table.remove(self.notes,i) end
function group:getParameter(name)
  if not self.curves[name] then
    local c={points={}}
    function c:getAllPoints() return self.points end
    function c:getDefinition() return {range={-1,1},defaultValue=0,typeName=name} end
    function c:removeAll() self.points={} end
    function c:add(x,y) self.points[#self.points+1]={x,y} end
    self.curves[name]=c
  end
  return self.curves[name]
end
local ref={}
function ref:getTarget() return group end
function ref:isMain() return true end
function ref:getTimeOffset() return 0 end
function ref:getPitchOffset() return 0 end
local track={name='Track'}
function track:getName() return self.name end
function track:setName(name) self.name=name end
function track:getNumGroups() return 1 end
function track:getGroupReference() return ref end
local project={undos=0,filename='/test.svp'}
function project:getFileName() return self.filename end
function project:getNumTracks() return 1 end
function project:getTrack() return track end
function project:getNumNoteGroupsInLibrary() return 0 end
function project:newUndoRecord() self.undos=self.undos+1 end
function project:getDuration() return 300 end
function project:getTimeAxis() return {getAllTempoMarks=function() return {{position=0,bpm=120}} end,getAllMeasureMarks=function() return {{position=0,numerator=4,denominator=4}} end} end
local pb={status='stopped',seconds=0}
function pb:getStatus() return self.status end
function pb:getPlayhead() return self.seconds end
function pb:seek(s) self.seconds=s end
function pb:play() self.status='playing' end
function pb:pause() self.status='paused' end
function pb:stop() self.status='stopped' end
local callbacks={}; local serial=0
SV={}
function SV:getProject() return project end
function SV:getHostInfo() return {hostVersion='test',hostName='fake'} end
function SV:getPlayback() return pb end
function SV:getMainEditor() return {getCurrentGroup=function() return ref end,getSelection=function() return {getSelectedNotes=function() return {group.notes[1]} end} end} end
function SV:create(kind)
  if kind=='Note' then return newNote() end
  serial=serial+1; return {getUUID=function() return 'session-'..serial end}
end
function SV:setTimeout(_,fn) callbacks[#callbacks+1]=fn end
function SV:finish() self.finishes=(self.finishes or 0)+1 end
function SV:showMessageBox(_,message) self.lastMessage=message end
local api=engine.create(SV)
local function params(v) return json.decode(json.encode(v)) end
local function revision() return api.sv_get_notes({groupUuid='group-uuid'}).revision end
local function expectError(code,fn)
  local ok,errorValue=pcall(fn); assert(not ok and errorValue.code==code,tostring(errorValue))
end
local old=revision()
expectError('INVALID_ARGUMENT',function() api.sv_update_notes(params({groupUuid='group-uuid',expectedRevision=old,updates={{index=1,set={pitch=65}},{index=2,set={duration=-1}}}}),{}) end)
assert(group.notes[1].pitch==60 and project.undos==0)
api.sv_update_notes(params({groupUuid='group-uuid',expectedRevision=old,updates={{index=1,set={onset=400}},{index=2,set={pitch=67}}}}),{})
assert(group.notes[1].pitch==67 and group.notes[2].pitch==60,'Onset reordering targeted the wrong note')
expectError('REVISION_CONFLICT',function() api.sv_delete_notes(params({groupUuid='group-uuid',expectedRevision=old,indices={1}}),{}) end)
old=revision(); group.notes[1].lyrics='手改'
expectError('REVISION_CONFLICT',function() api.sv_update_notes(params({groupUuid='group-uuid',expectedRevision=old,updates={{index=1,set={pitch=61}}}}),{}) end)
local before=#group.notes
api.sv_add_notes(params({groupUuid='group-uuid',expectedRevision=revision(),notes={{pitch=64,onset=600,duration=100,lyrics='新增'}}}),{})
assert(#group.notes==before+1)
api.sv_delete_notes(params({groupUuid='group-uuid',expectedRevision=revision(),indices={3}}),{})
assert(#group.notes==before)
expectError('INVALID_ARGUMENT',function() api.sv_set_parameter_points(params({groupUuid='group-uuid',expectedRevision=revision(),parameter='tension',points={{0,2}}}),{}) end)
api.sv_set_parameter_points(params({groupUuid='group-uuid',expectedRevision=revision(),parameter='tension',points={{0,.2}}}),{})
assert(group.curves.tension.points[1][2]==.2)
assert(#api.sv_get_selected_notes({}).notes==1)
expectError('TRACK_CONFLICT',function() api.sv_rename_track({trackIndex=1,trackUuid='other',expectedName='Track',name='Wrong'}, {}) end)
api.sv_rename_track({trackIndex=1,trackUuid='group-uuid',expectedName='Track',name='测试'}, {})
assert(track.name=='测试')
assert(api.sv_playback({action='seek',seconds=15}).seconds==15)
expectError('UNKNOWN_METHOD',function() api.execute('sv_execute_lua',{}, {}) end)
local extra=setmetatable({notes={newNote(55,600)},curves={}},{__index=group})
function extra:getUUID() return 'unreferenced-group' end
function project:getNumNoteGroupsInLibrary() return 1 end
function project:getNoteGroup() return extra end
assert(api.sv_read_project({}).groups['unreferenced-group'].notes[1].pitch==55,'Unreferenced library group was omitted')
function project:getNumNoteGroupsInLibrary() return 0 end
-- Structural guards cover manual note edits and reject complete invalid batches before undo.
local voice={vocalModeParams={Soft={pitch=100,timbre=100,pronunciation=100}}}
function ref:getVoice() return json.decode(json.encode(voice)) end
function ref:setVoice(p) for k,v in pairs(p)do voice[k]=v end end
function ref:isMuted()return false end
local mixer={gainDecibel=0,pan=0,muted=false,solo=false}
for _,k in ipairs({'gainDecibel','pan','muted','solo'})do
 local upper=k:sub(1,1):upper()..k:sub(2)
 mixer[(k=='muted' or k=='solo') and 'is'..upper or 'get'..upper]=function(self)return self[k]end
 mixer['set'..upper]=function(self,v)self[k]=v end
end
function track:getMixer()return mixer end
local extended=engine.create(SV,assert(loadfile(sourceDir..'/extended.lua'))())
local function structure()return extended.sv_get_project_structure({})end
local sr=structure().revision;group.notes[1].lyrics='结构保护手改'
expectError('PROJECT_REVISION_CONFLICT',function()extended.sv_set_track_mixer({expectedProjectRevision=sr,trackIndex=1,trackUuid='group-uuid',set={pan=.5}}, {})end)
local undoBefore=project.undos
expectError('INVALID_ARGUMENT',function()extended.sv_set_track_mixer({expectedProjectRevision=structure().revision,trackIndex=1,trackUuid='group-uuid',set={pan=.5,gainDecibel=25}}, {})end)
assert(mixer.pan==0 and project.undos==undoBefore)
extended.sv_set_track_mixer({expectedProjectRevision=structure().revision,trackIndex=1,trackUuid='group-uuid',set={pan=.5}}, {})
assert(mixer.pan==.5 and structure().revision~=sr)
expectError('INVALID_ARGUMENT',function()extended.sv_set_time_axis(params({expectedProjectRevision=structure().revision,tempo={{position=100,bpm=120},{position=200,bpm=-1}}}), {})end)
assert(project.undos==undoBefore+1)
extended.sv_set_voice_attributes({expectedProjectRevision=structure().revision,trackIndex=1,trackUuid='group-uuid',referenceIndex=1,groupUuid='group-uuid',attributes={vocalModeParams={Soft={pitch=80}}}}, {})
assert(voice.vocalModeParams.Soft.pitch==80 and voice.vocalModeParams.Soft.timbre==100,'Nested voice patch erased untouched fields')
expectError('INVALID_ARGUMENT',function()extended.sv_detach_note_group({expectedProjectRevision=structure().revision,trackIndex=1,trackUuid='group-uuid',referenceIndex=1,groupUuid='group-uuid'}, {})end)
local function write(path,value) local f=assert(io.open(path,'w')); f:write(json.encode(value)); f:close() end
local function read(path) local f=assert(io.open(path,'r'));local out=json.decode(f:read('*a'));f:close();return out end
write(bus..'/bridge-config.json',{protocolVersion=1,pollMs=50,heartbeatMs=1000,staleMs=6000,maxPerTick=4})
local function main() local bridge=assert(loadfile(sourceDir..'/SVAgentBridge.lua'))(bus,sourceDir);bridge.main() end
main(); local session=read(bus..'/session.json'); assert(session.state=='running')
local function tick() assert(table.remove(callbacks,1))() end
local function enqueue(id,method,p,overrides)
  local r={protocolVersion=1,id=id,sessionId=session.sessionId,projectFile=project.filename,method=method,params=p,createdAt=os.time()*1000,deadlineAt=os.time()*1000+10000}
  for k,v in pairs(overrides or {}) do r[k]=v end
  write(bus..'/requests/'..id..'.json',r)
  write(bus..'/queue.json',{protocolVersion=1,entries=json.array({{id=id,sessionId=session.sessionId}})})
  return r
end
local function response(id) return read(bus..'/replies/'..id..'.json') end
local u=project.undos
enqueue('expired','sv_update_notes',params({groupUuid='group-uuid',expectedRevision=revision(),updates={{index=1,set={pitch=69}}}}),{deadlineAt=0});tick()
assert(response('expired').error.code=='REQUEST_EXPIRED' and project.undos==u)
enqueue('cancelled','sv_get_project_summary',{});write(bus..'/cancellations/cancelled.json',{});tick()
assert(response('cancelled').error.code=='REQUEST_CANCELLED')
enqueue('edit','sv_update_notes',params({groupUuid='group-uuid',expectedRevision=revision(),updates={{index=1,set={pitch=68}}}}));tick();tick()
assert(response('edit').ok and project.undos==u+1,'Duplicate edit replayed')
local r=enqueue('interrupted','sv_update_notes',params({groupUuid='group-uuid',expectedRevision=revision(),updates={{index=1,set={pitch=70}}}}))
write(bus..'/receipts/interrupted.json',{state='executing',request=json.encode(r)});tick()
assert(response('interrupted').error.code=='INDETERMINATE' and project.undos==u+1)
enqueue('reply-fault','sv_update_notes',params({groupUuid='group-uuid',expectedRevision=revision(),updates={{index=1,set={pitch=69}}}}))
local open=io.open
io.open=function(path,mode) if path:find('/replies/reply%-fault%.json%.') and mode=='wb' then return nil,'simulated reply failure' end;return open(path,mode) end
tick();io.open=open
assert(read(bus..'/receipts/reply-fault.json').state=='completed')
tick();assert(response('reply-fault').ok and project.undos==u+2,'Completed receipt did not prevent reexecution')
enqueue('receipt-fault','sv_update_notes',params({groupUuid='group-uuid',expectedRevision=revision(),updates={{index=1,set={pitch=70}}}}))
local writes=0
io.open=function(path,mode)
  if path:find('/receipts/receipt%-fault%.json%.') and mode=='wb' then writes=writes+1;if writes==2 then return nil,'simulated receipt failure' end end
  return open(path,mode)
end
tick();io.open=open;assert(read(bus..'/receipts/receipt-fault.json').state=='executing')
tick();assert(response('receipt-fault').error.code=='INDETERMINATE' and project.undos==u+3,'Interrupted edit replayed')
local clock=os.time;os.time=function() return clock()+121 end
tick();local finishes=SV.finishes or 0;main();assert((SV.finishes or 0)==finishes,'Duplicate start terminated the active script');assert(read(bus..'/session.json').sessionId==session.sessionId,'Running bridge was replaced after 120 seconds');os.time=clock
tick() -- The previous runtime is fenced; it must not finish the newly scheduled loop.
assert((SV.finishes or 0)==finishes,'Fenced callback terminated the new runtime')
enqueue('stop','sv_stop_bridge',{});tick();assert(response('stop').ok and read(bus..'/session.json').state=='stopped')
callbacks={};main();session=read(bus..'/session.json');project.filename='/different.svp';tick()
assert(read(bus..'/session.json').reason=='project_changed')
print('all Lua checks passed')
