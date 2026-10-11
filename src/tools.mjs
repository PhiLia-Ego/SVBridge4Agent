import * as z from 'zod/v4';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const index = z.number().int().min(1);
const text = z.string().max(4096);
const groupUuid = z.string().min(1).max(80);
const expectedRevision = z.string().min(1).describe('Revision returned by sv_get_notes/sv_get_parameter_points. Reread after every edit.');
const noteFields = {
  onset: integer, duration: integer.min(1), pitch: z.number().int().min(0).max(127), lyrics: text, phonemes: text,
};
const patch = z.object(Object.fromEntries(Object.entries(noteFields).map(([k, v]) => [k, v.optional()]))).strict();
export const toolDefinitions = {
  sv_get_project_summary: { description: 'Read live project tracks, groups, tempo, meter and playback. Track and note indices are 1-based.', schema: z.object({}).strict(), readOnly: true },
  sv_read_project: { description: 'Read live tracks, main groups, library groups (including unreferenced groups), notes and supported curves (maximum 20000 unique notes). Group onsets use blicks, playback uses seconds.', schema: z.object({}).strict(), readOnly: true },
  sv_get_notes: { description: 'Read a group by UUID with its current revision. Editing a shared group affects all its references. Note positions are relative to the group, in blicks.', schema: z.object({ groupUuid, startIndex: index.default(1), count: index.max(2000).default(500) }).strict(), readOnly: true },
  sv_get_selected_notes: { description: 'Read the piano-roll selection and current group revision.', schema: z.object({}).strict(), readOnly: true },
  sv_update_notes: { description: 'Update existing note fields in one undo record. A matching group revision is required; all patches are validated before editing.', schema: z.object({ groupUuid, expectedRevision, updates: z.array(z.object({ index, set: patch }).strict()).min(1).max(1000) }).strict() },
  sv_add_notes: { description: 'Add notes to a group in one undo record. Return the new group revision. Host may reorder notes by onset.', schema: z.object({ groupUuid, expectedRevision, notes: z.array(z.object({ ...noteFields, phonemes: text.optional() }).strict()).min(1).max(1000) }).strict() },
  sv_delete_notes: { description: 'Remove 1-based note indices from a group in one undo record. Check the revision first.', schema: z.object({ groupUuid, expectedRevision, indices: z.array(index).min(1).max(1000) }).strict() },
  sv_get_parameter_points: { description: 'Read group parameter definitions and control points plus the group revision.', schema: z.object({ groupUuid, parameter: z.enum(['pitchDelta','vibratoEnv','loudness','tension','breathiness','voicing','gender','toneShift']) }).strict(), readOnly: true },
  sv_set_parameter_points: { description: 'Replace or merge group control points in one undo record. Positions are blicks; values must fit the host parameter range.', schema: z.object({ groupUuid, expectedRevision, parameter: z.enum(['pitchDelta','vibratoEnv','loudness','tension','breathiness','voicing','gender','toneShift']), mode: z.enum(['replace','merge']).default('replace'), points: z.array(z.tuple([integer,z.number()])).max(2000) }).strict() },
  sv_rename_track: { description: 'Rename one track in an undo record. trackUuid (main group UUID) and expectedName prevent targeting a moved/replaced track.', schema: z.object({ trackIndex: index, trackUuid: groupUuid, expectedName: text, name: text.min(1) }).strict() },
  sv_playback: { description: 'Control play/pause/stop/seek. seek uses seconds, not blicks.', schema: z.object({ action: z.enum(['play','pause','stop','seek']), seconds: z.number().min(0).max(86400).optional() }).strict() },
  sv_stop_bridge: { description: 'Stop this bridge session cleanly, leaving Studio and its project open.', schema: z.object({}).strict() },
};
const projectGuard = { expectedProjectRevision: z.string().min(1).describe('Revision from sv_get_project_structure; reread after edits.') };
const trackGuard = { trackIndex: index, trackUuid: groupUuid };
const refGuard = { ...trackGuard, referenceIndex: index, groupUuid };
const nonempty = schema => schema.refine(v => Object.keys(v).length > 0, 'Patch must not be empty');
const add = (name, description, fields, readOnly=false) => { toolDefinitions[name] = { description, schema: z.object(fields).strict(), readOnly }; };
add('sv_get_project_structure','Read guarded project structure, mixer, reference voice attributes and group revisions.',{},true);
add('sv_get_playback','Read the playhead and playback status.',{},true);
add('sv_create_track','Create a track with its automatic main group.',{...projectGuard,name:text.min(1)});
add('sv_remove_track','Remove a track and its references. The last track cannot be removed.',{...projectGuard,...trackGuard});
add('sv_create_note_group','Create an empty library group.',{...projectGuard,name:text.min(1)});
add('sv_rename_note_group','Rename a shared note group.',{...projectGuard,groupUuid,name:text.min(1)});
add('sv_remove_note_group','Remove an unreferenced library group. Detach its references first.',{...projectGuard,groupUuid});
add('sv_attach_note_group','Attach a library group to a track; offsets use blicks and semitones.',{...projectGuard,...trackGuard,groupUuid,timeOffset:integer.default(0),pitchOffset:z.number().int().min(-127).max(127).default(0)});
add('sv_detach_note_group','Detach a reference while retaining the library group. Main groups cannot be detached.',{...projectGuard,...refGuard});
add('sv_set_group_reference','Set a reference offset or muted state.',{...projectGuard,...refGuard,set:nonempty(z.object({timeOffset:integer.optional(),pitchOffset:z.number().int().min(-127).max(127).optional(),muted:z.boolean().optional()}).strict())});
add('sv_set_track_mixer','Set gain (-24..24 dB), pan (-1..1), mute or solo.',{...projectGuard,...trackGuard,set:nonempty(z.object({gainDecibel:z.number().min(-24).max(24).optional(),pan:z.number().min(-1).max(1).optional(),muted:z.boolean().optional(),solo:z.boolean().optional()}).strict())});
const mode=nonempty(z.object(Object.fromEntries(['pitch','timbre','pronunciation'].map(k=>[k,z.number().min(0).max(150).optional()]))).strict());
add('sv_set_voice_attributes','Set reference voice attributes and named vocal mode parameters (use mode names supported by the assigned singer); does not select a singer database.',{...projectGuard,...refGuard,attributes:nonempty(z.object({paramLoudness:z.number().min(-24).max(24).optional(),paramTension:z.number().min(-1).max(1).optional(),paramBreathiness:z.number().min(-1).max(1).optional(),paramGender:z.number().min(-1).max(1).optional(),paramToneShift:z.number().min(-400).max(400).optional(),vocalModeParams:z.record(z.string().min(1).max(100),mode).optional()}).strict())});
add('sv_set_time_axis','Add/replace/remove tempo marks (blick positions) and meter marks (zero-based measure numbers). Origin marks cannot be removed.',{...projectGuard,tempo:z.array(z.union([z.object({position:integer,bpm:z.number().min(20).max(400)}).strict(),z.object({position:integer.min(1),remove:z.literal(true)}).strict()])).max(128).optional(),meter:z.array(z.union([z.object({measure:integer.max(1000000),numerator:index.max(32),denominator:z.union([z.literal(1),z.literal(2),z.literal(4),z.literal(8),z.literal(16),z.literal(32)])}).strict(),z.object({measure:integer.min(1).max(1000000),remove:z.literal(true)}).strict()])).max(128).optional()});
export const audioSchema = z.object({sessionId:z.string().min(1).max(80),requestId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),startSeconds:z.number().min(0).max(86400),durationSeconds:z.number().min(0.5).max(120),tailSeconds:z.number().min(0).max(3).default(0.3)}).strict();
export const requestOptions = {
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional().describe('Use the same ID for a retry; IDs cannot be reused for other payloads/sessions.'),
  sessionId: z.string().optional().describe('Pin a known session ID to prevent silently switching projects.'),
  timeoutMs: z.number().int().min(2000).max(60000).default(5000),
};
export function capabilities() {
  return { protocolVersion: 1, tools: ['sv_status','sv_capabilities','sv_get_request_result','sv_audio_status','sv_capture_audio','sv_get_audio_result',...Object.keys(toolDefinitions)],
    units: { noteTime: 'blicks', quarterNote: 705600000, playbackTime: 'seconds', pitch: 'MIDI integer', indices: '1-based' },
    revision: 'Group revisions cover notes/curves; project revisions also cover structure, time axis, mixer and voice attributes. Reread before edits.',
    audio: { platform: 'macOS 14.2+', transport: 'Core Audio process tap filtered to SV2 Pro', format: 'Float32 stereo WAV', realtime: true, maximumSeconds: 120 },
    transport: 'Atomic per-request JSON files, atomic queue index, heartbeat and persistent execution receipts.',
    limits: { pendingRequests: 256, editsPerRequest: 1000, snapshotNotes: 20000 },
    unsupported: ['arbitrary Lua execution','project save','offline audio export','voice-library selection'],
    note: 'One active Studio bridge per queue directory. UI undo is supported; file IPC is not a host database transaction.' };
}
