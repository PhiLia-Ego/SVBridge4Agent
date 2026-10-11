-- Explicit structural, time-axis, voice-attribute and mixer interfaces.
return function(api,h)
  local SV,json,project,group,revision,trackUuid,mutate,hash,keys,check,integer,list,fail=h.SV,h.json,h.project,h.group,h.revision,h.trackUuid,h.mutate,h.hash,h.keys,h.check,h.integer,h.list,h.fail
  local function structure()
    local s=api.sv_get_project_summary({}); s.playback=nil
    local seen={}
    for _,t in ipairs(s.tracks) do
      local track=project():getTrack(t.index); local m=track:getMixer()
      t.mixer={gainDecibel=m:getGainDecibel(),pan=m:getPan(),muted=m:isMuted(),solo=m:isSolo()}
      for _,r in ipairs(t.groups) do
        local ref=track:getGroupReference(r.referenceIndex)
        r.voice=ref:getVoice(); r.muted=ref:isMuted(); seen[r.groupUuid]=true
      end
    end
    for _,g in ipairs(s.libraryGroups) do seen[g.groupUuid]=true end
    local revisions={}; for uuid in pairs(seen) do revisions[uuid]=revision(group(uuid)) end
    s.groupRevisions=revisions; s.revision=hash(json.encode(s)); return s
  end
  local function guard(p,allowed)
    allowed.expectedProjectRevision=true; keys(p,allowed)
    check(type(p.expectedProjectRevision)=='string','expectedProjectRevision is required')
    if p.expectedProjectRevision~=structure().revision then fail('PROJECT_REVISION_CONFLICT','Project changed. Reread sv_get_project_structure.') end
  end
  local function track(p)
    check(integer(p.trackIndex,1,project():getNumTracks()),'Invalid trackIndex')
    local t=project():getTrack(p.trackIndex)
    if p.trackUuid~=trackUuid(t) then fail('TRACK_CONFLICT','Track identity changed') end
    return t
  end
  local function ref(p)
    local t=track(p); check(integer(p.referenceIndex,1,t:getNumGroups()),'Invalid referenceIndex')
    local r=t:getGroupReference(p.referenceIndex)
    if r:getTarget():getUUID()~=p.groupUuid then fail('GROUP_CONFLICT','Group reference identity changed') end
    return r,t
  end
  local function name(v) check(type(v)=='string' and #v>0 and #v<=4096,'Invalid name') end
  local function done(ctx,fn) return mutate(ctx,function() local result=fn() or {}; result.revision=structure().revision; return result end) end
  local function number(v,min,max) return type(v)=='number' and v>=min and v<=max end
  function api.sv_get_project_structure(p) keys(p,{}); return structure() end
  function api.sv_get_playback(p) keys(p,{}); local pb=SV:getPlayback();return {status=pb:getStatus(),seconds=pb:getPlayhead()} end
  function api.sv_create_track(p,ctx)
    guard(p,{name=true}); name(p.name)
    return done(ctx,function() local t=SV:create('Track');t:setName(p.name); project():addTrack(t); return {trackIndex=t:getIndexInParent(),trackUuid=trackUuid(t)} end)
  end
  function api.sv_remove_track(p,ctx)
    guard(p,{trackIndex=true,trackUuid=true}); track(p)
    check(project():getNumTracks()>1,'Cannot remove the last track')
    return done(ctx,function() project():removeTrack(p.trackIndex) end)
  end
  function api.sv_create_note_group(p,ctx)
    guard(p,{name=true});name(p.name)
    return done(ctx,function() local g=SV:create('NoteGroup');g:setName(p.name);project():addNoteGroup(g);return {groupUuid=g:getUUID()} end)
  end
  function api.sv_rename_note_group(p,ctx)
    guard(p,{groupUuid=true,name=true});name(p.name);local g=group(p.groupUuid)
    return done(ctx,function()g:setName(p.name)end)
  end
  function api.sv_remove_note_group(p,ctx)
    guard(p,{groupUuid=true}); local g=group(p.groupUuid);local index
    for ti=1,project():getNumTracks() do local t=project():getTrack(ti);for i=1,t:getNumGroups() do
      check(t:getGroupReference(i):getTarget():getUUID()~=p.groupUuid,'Detach all references before removing a library group')
    end end
    for i=1,project():getNumNoteGroupsInLibrary() do if project():getNoteGroup(i):getUUID()==g:getUUID() then index=i end end
    check(index~=nil,'Only library groups can be removed')
    return done(ctx,function()project():removeNoteGroup(index)end)
  end
  function api.sv_attach_note_group(p,ctx)
    guard(p,{trackIndex=true,trackUuid=true,groupUuid=true,timeOffset=true,pitchOffset=true})
    local t=track(p);local g=group(p.groupUuid); local library=false
    for i=1,project():getNumNoteGroupsInLibrary() do if project():getNoteGroup(i):getUUID()==p.groupUuid then library=true end end
    check(library,'Only library groups can be attached');check(integer(p.timeOffset or 0,0,9007199254740991) and integer(p.pitchOffset or 0,-127,127),'Invalid offsets')
    return done(ctx,function()local r=SV:create('NoteGroupReference');r:setTarget(g);r:setTimeOffset(p.timeOffset or 0);r:setPitchOffset(p.pitchOffset or 0);t:addGroupReference(r);return {referenceIndex=r:getIndexInParent(),groupUuid=g:getUUID()}end)
  end
  function api.sv_detach_note_group(p,ctx)
    guard(p,{trackIndex=true,trackUuid=true,referenceIndex=true,groupUuid=true});local r,t=ref(p);check(not r:isMain(),'Cannot detach a main group')
    return done(ctx,function()t:removeGroupReference(p.referenceIndex)end)
  end
  function api.sv_set_group_reference(p,ctx)
    guard(p,{trackIndex=true,trackUuid=true,referenceIndex=true,groupUuid=true,set=true});local r=ref(p)
    keys(p.set,{timeOffset=true,pitchOffset=true,muted=true});check(next(p.set)~=nil,'Empty reference patch')
    if p.set.timeOffset~=nil then check(integer(p.set.timeOffset,0,9007199254740991) and not r:isMain(),'Invalid main-group/time offset') end
    if p.set.pitchOffset~=nil then check(integer(p.set.pitchOffset,-127,127),'Invalid pitch offset') end
    if p.set.muted~=nil then check(type(p.set.muted)=='boolean','Invalid muted') end
    return done(ctx,function()for k,v in pairs(p.set)do local methods={timeOffset='setTimeOffset',pitchOffset='setPitchOffset',muted='setMuted'};r[methods[k]](r,v)end end)
  end
  function api.sv_set_track_mixer(p,ctx)
    guard(p,{trackIndex=true,trackUuid=true,set=true});local m=track(p):getMixer()
    keys(p.set,{gainDecibel=true,pan=true,muted=true,solo=true});check(next(p.set)~=nil,'Empty mixer patch')
    for k,v in pairs(p.set) do if k=='gainDecibel' then check(number(v,-24,24),'Gain range is -24 to 24 dB') elseif k=='pan' then check(number(v,-1,1),'Pan range is -1 to 1') else check(type(v)=='boolean','Mixer flags must be boolean') end end
    return done(ctx,function() local setters={gainDecibel='setGainDecibel',pan='setPan',muted='setMuted',solo='setSolo'};for k,v in pairs(p.set)do m[setters[k]](m,v)end end)
  end
  function api.sv_set_voice_attributes(p,ctx)
    guard(p,{trackIndex=true,trackUuid=true,referenceIndex=true,groupUuid=true,attributes=true});local r=ref(p)
    keys(p.attributes,{paramLoudness=true,paramTension=true,paramBreathiness=true,paramGender=true,paramToneShift=true,vocalModeParams=true});check(next(p.attributes)~=nil,'Empty voice patch')
    for k,v in pairs(p.attributes)do
      if k=='vocalModeParams' then
        check(type(v)=='table' and not json.isArray(v) and v~=json.null and next(v)~=nil,'Expected vocal modes object')
        for mode,values in pairs(v)do
          check(type(mode)=='string' and #mode>0 and #mode<=100,'Invalid vocal mode name');keys(values,{pitch=true,timbre=true,pronunciation=true});check(next(values)~=nil,'Empty vocal mode')
          for _,value in pairs(values)do check(number(value,0,150),'Vocal mode range is 0 to 150')end
        end
      else
        local range=({paramLoudness={-24,24},paramToneShift={-400,400}})[k] or {-1,1}
        check(number(v,range[1],range[2]),'Voice attribute outside allowed range: '..k)
      end
    end
    -- Merge nested modes because setVoice only promises a shallow partial update.
    local patch={};for k,v in pairs(p.attributes)do patch[k]=v end
    if patch.vocalModeParams then local modes=r:getVoice().vocalModeParams or {};for mode,values in pairs(patch.vocalModeParams)do modes[mode]=modes[mode] or {};for k,v in pairs(values)do modes[mode][k]=v end end;patch.vocalModeParams=modes end
    return done(ctx,function()r:setVoice(patch)end)
  end
  function api.sv_set_time_axis(p,ctx)
    guard(p,{tempo=true,meter=true});local tempo=p.tempo or json.array();local meter=p.meter or json.array();list(tempo,0,128);list(meter,0,128);check(#tempo+#meter>0,'No time-axis edits')
    local seen={}
    for _,m in ipairs(tempo)do keys(m,{position=true,bpm=true,remove=true});check(integer(m.position,0,9007199254740991) and not seen[m.position],'Invalid/duplicate tempo position');seen[m.position]=true
      if m.remove==true then check(m.position>0 and m.bpm==nil,'Cannot remove origin tempo / provide bpm with remove')else check(m.remove==nil and number(m.bpm,20,400),'Invalid tempo BPM')end
    end
    seen={};for _,m in ipairs(meter)do keys(m,{measure=true,numerator=true,denominator=true,remove=true});check(integer(m.measure,0,1000000) and not seen[m.measure],'Invalid/duplicate measure');seen[m.measure]=true
      if m.remove==true then check(m.measure>0 and m.numerator==nil and m.denominator==nil,'Cannot remove origin meter / provide values with remove')else check(m.remove==nil and integer(m.numerator,1,32) and ({[1]=true,[2]=true,[4]=true,[8]=true,[16]=true,[32]=true})[m.denominator],'Invalid meter')end
    end
    return done(ctx,function()local a=project():getTimeAxis();for _,m in ipairs(tempo)do if m.remove then a:removeTempoMark(m.position)else a:addTempoMark(m.position,m.bpm)end end;for _,m in ipairs(meter)do if m.remove then a:removeMeasureMark(m.measure)else a:addMeasureMark(m.measure,m.numerator,m.denominator)end end end)
  end
end
