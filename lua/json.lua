-- Strict, dependency-free JSON codec for the embedded Lua runtime.
local json = { null = {} }
local arrayMT = {}
function json.array(t) return setmetatable(t or {}, arrayMT) end
function json.isArray(t) return type(t) == "table" and getmetatable(t) == arrayMT end
local escapes = { ['"']='\\"', ['\\']='\\\\', ['\b']='\\b', ['\f']='\\f', ['\n']='\\n', ['\r']='\\r', ['\t']='\\t' }
local function quote(s)
  return '"' .. s:gsub('[%z\1-\31\\"]', function(c) return escapes[c] or string.format('\\u%04x',c:byte()) end) .. '"'
end
function json.encode(value)
  local seen = {}
  local function encode(v,depth)
    if depth > 64 then error('JSON nesting limit exceeded') end
    if v == json.null or v == nil then return 'null' end
    local kind = type(v)
    if kind == 'boolean' then return tostring(v) end
    if kind == 'number' then
      if v ~= v or v == math.huge or v == -math.huge then error('Non-finite JSON number') end
      return math.type(v) == 'integer' and tostring(v) or string.format('%.17g',v)
    end
    if kind == 'string' then return quote(v) end
    if kind ~= 'table' then error('Unsupported JSON type: '..kind) end
    if seen[v] then error('Cyclic JSON value') end
    seen[v] = true
    local parts, keys = {}, {}
    local isArray = json.isArray(v) or (#v > 0)
    if isArray then
      for k in pairs(v) do if type(k)~='number' or k%1~=0 or k<1 or k>#v then error('Non-contiguous JSON array') end end
      for i=1,#v do parts[i]=encode(v[i],depth+1) end
    else
      for k in pairs(v) do if type(k)~='string' then error('JSON object key must be a string') end; keys[#keys+1]=k end
      table.sort(keys)
      for _,k in ipairs(keys) do parts[#parts+1]=quote(k)..':'..encode(v[k],depth+1) end
    end
    seen[v]=nil
    return (isArray and '[' or '{')..table.concat(parts,',')..(isArray and ']' or '}')
  end
  return encode(value,0)
end
local function utf8char(n)
  if n<128 then return string.char(n) end
  if n<2048 then return string.char(192+n//64,128+n%64) end
  if n<65536 then return string.char(224+n//4096,128+(n//64)%64,128+n%64) end
  return string.char(240+n//262144,128+(n//4096)%64,128+(n//64)%64,128+n%64)
end
function json.decode(s)
  if type(s)~='string' or #s>4*1024*1024 then error('Invalid JSON input size') end
  local pos=1
  local function fail(message) error(message..' at byte '..pos) end
  local function ws() while s:sub(pos,pos):match('[ \t\r\n]') do pos=pos+1 end end
  local parse
  local function stringValue()
    pos=pos+1; local chunks={}
    while pos<=#s do
      local c=s:sub(pos,pos); pos=pos+1
      if c=='"' then return table.concat(chunks) end
      if c=='\\' then
        local e=s:sub(pos,pos); pos=pos+1
        local plain={['"']='"',['\\']='\\',['/']='/',b='\b',f='\f',n='\n',r='\r',t='\t'}
        if plain[e] then chunks[#chunks+1]=plain[e]
        elseif e=='u' then
          local h=s:sub(pos,pos+3)
          if not h:match('^%x%x%x%x$') then fail('Invalid Unicode escape') end
          local n=tonumber(h,16); pos=pos+4
          if n>=0xD800 and n<=0xDBFF then
            if s:sub(pos,pos+1)~='\\u' then fail('Missing low surrogate') end
            local low=s:sub(pos+2,pos+5)
            if not low:match('^%x%x%x%x$') then fail('Invalid low surrogate') end
            local l=tonumber(low,16)
            if l<0xDC00 or l>0xDFFF then fail('Invalid low surrogate') end
            n=0x10000+(n-0xD800)*1024+l-0xDC00; pos=pos+6
          elseif n>=0xDC00 and n<=0xDFFF then fail('Unexpected low surrogate') end
          chunks[#chunks+1]=utf8char(n)
        else fail('Invalid escape') end
      else
        if c:byte()<32 then fail('Unescaped control character') end
        chunks[#chunks+1]=c
      end
    end
    fail('Unterminated string')
  end
  function parse(depth)
    if depth>64 then fail('JSON nesting limit exceeded') end
    ws(); local c=s:sub(pos,pos)
    if c=='"' then return stringValue() end
    if c=='{' or c=='[' then
      local object=c=='{'; local v=object and {} or json.array(); pos=pos+1; ws()
      local ending=object and '}' or ']'
      if s:sub(pos,pos)==ending then pos=pos+1; return v end
      while true do
        ws(); local key
        if object then
          if s:sub(pos,pos)~='"' then fail('Expected object key') end
          key=stringValue(); ws()
          if v[key]~=nil then fail('Duplicate object key') end
          if s:sub(pos,pos)~=':' then fail('Expected colon') end
          pos=pos+1
        else key=#v+1 end
        v[key]=parse(depth+1); ws(); local sep=s:sub(pos,pos); pos=pos+1
        if sep==ending then return v end
        if sep~=',' then fail('Expected comma or '..ending) end
      end
    end
    for literal,value in pairs({['true']=true,['false']=false,['null']=json.null}) do
      if s:sub(pos,pos+#literal-1)==literal then pos=pos+#literal; return value end
    end
    local start=pos
    if c=='-' then pos=pos+1 end
    local first=s:sub(pos,pos)
    if first=='0' then pos=pos+1
    elseif first:match('[1-9]') then repeat pos=pos+1 until not s:sub(pos,pos):match('%d')
    else fail('Expected JSON value') end
    if s:sub(pos,pos)=='.' then
      pos=pos+1; if not s:sub(pos,pos):match('%d') then fail('Invalid fraction') end
      repeat pos=pos+1 until not s:sub(pos,pos):match('%d')
    end
    if s:sub(pos,pos):match('[eE]') then
      pos=pos+1; if s:sub(pos,pos):match('[+-]') then pos=pos+1 end
      if not s:sub(pos,pos):match('%d') then fail('Invalid exponent') end
      repeat pos=pos+1 until not s:sub(pos,pos):match('%d')
    end
    local value=tonumber(s:sub(start,pos-1))
    if not value or value==math.huge or value==-math.huge then fail('Invalid number') end
    return value
  end
  local value=parse(0); ws()
  if pos<=#s then fail('Trailing JSON data') end
  return value
end
return json
