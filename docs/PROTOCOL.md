# 原子文件队列协议 v1

通信目录由外部安装器建立；Lua 只使用普通文件操作，不启动 shell 或网络进程。每个客户端都使用同一套 publisher.lock 配置协调索引写入。

```text
bridge-config.json        配置：50 ms 轮询、1000 ms 心跳、6000 ms 过期
session.json              Lua 唯一写入：当前会话和工程路径
queue.json                Node 写入：最多 256 个待处理 {id, sessionId}
publisher.lock/           proper-lockfile 管理的索引发布锁
requests/<id>.json        Node 写入：不可变请求
receipts/<id>.json        Lua 写入：executing / completed 执行记录
replies/<id>.json         Lua 写入：对应请求的完整结果
cancellations/<id>.json   Node 写入：取消意图
```

ID 限制为 1–80 个 ASCII 字母、数字、下划线、连字符。请求上限 512 KiB，结果上限 2 MiB，执行记录和其他 JSON 文件读取上限 4 MiB，JSON 深度最多 64。记录同时包含请求和结果，这些限制避免产生无法回读的记录。业务参数在 MCP 和 Lua 两端校验；Lua 不执行请求中的代码。

## 发布和领取

Node 获得索引发布锁，检查新鲜会话，再用独立临时文件发布请求。之后读索引、清理有回复或属于旧会话的条目，追加新 ID，原子替换索引。请求先于索引出现；Lua 不会领取未被索引引用的文件。崩溃产生的孤立请求可用原 ID 重试，补回索引，不会产生队列序号空洞。

Lua 按索引顺序领取，跳过已存在回复的 ID 和其他会话。每次先校验请求，再检查历史执行记录、期限和取消标记。没有执行记录时先原子发布 executing，然后调用宿主 API。

```json
{
  "protocolVersion": 1,
  "id": "unique-request-id",
  "sessionId": "uuid-from-session",
  "projectFile": "/absolute/project.svp",
  "method": "sv_get_notes",
  "params": { "groupUuid": "group-uuid", "startIndex": 1, "count": 500 },
  "createdAt": 1700000000000,
  "deadlineAt": 1700000005000
}
```

业务结果与错误统一包装：

```json
{
  "protocolVersion": 1,
  "id": "unique-request-id",
  "sessionId": "uuid-from-session",
  "completedAt": 1700000001000,
  "ok": true,
  "result": { "groupUuid": "group-uuid", "revision": "opaque-revision", "notes": [] }
}
```

失败包装使用 ok=false 和 error；error 至少含 code、message，Lua 操作还含 mayHaveApplied。Node 必须匹配协议版本、ID 和 sessionId 才能将回复作为成功结果返回。

## 执行记录与重试

执行记录保存 canonical JSON 请求，用于发现同 ID 的载荷改变。

| 中断位置 | 恢复行为 |
| --- | --- |
| 发布请求后、发布索引前 | 原 ID 重试补回索引 |
| executing 发布前 | 可正常领取执行 |
| executing 已发布，但没有完整结果 | INDETERMINATE，保守地拒绝重做 |
| completed 已发布、回复尚未发布 | 从执行记录重发原回复 |
| 回复已发布 | 原 ID 直接返回保存的回复 |

记录先于宿主编辑写入，能够防止请求因回复丢失而自动重复编辑；宿主工程和本地 JSON 不属于同一数据库事务。因此不能判定“executing 后崩溃”究竟有没有改变工程，错误信息明确保留这个不确定性。

Node 发布使用文件同步后 rename；Lua 标准库没有 fsync，使用写完、关闭、rename。协议关注完整可见性及进程中断恢复，未验证突然断电的落盘保证。临时文件与目标文件必须在同一目录。

## 会话和冲突

sessionId 在启动时使用宿主生成的 UUID，与请求 ID 分开。runtimeId 标识本次脚本执行环境；重复点击时，若工程身份、路径和心跳匹配，保留 sessionId，更新 runtimeId 并恢复轮询。Studio 会在重新执行脚本时重置原环境，因此不能只返回，也不能在重复调用中执行 finish。旧回调若存活，发现 runtimeId 改变后直接退出，不调用 finish，以免终止新环境。

projectToken 使用第一条轨道主组的 UUID，辅助发现同一路径被重新打开后已换成另一份运行态对象。Lua 每次轮询检查 sessionId、runtimeId、路径及工程身份；只有持有当前 runtimeId 的环境写入心跳。heartbeatAt 使用 Unix 毫秒格式，Lua 的精度实际为秒。

MCP 读取请求默认绑定调用开始时的会话，也可显式传 sessionId；编辑、播放控制和停止工具必须显式传 sessionId。不同工程路径会停止现有桥接；新会话不消费旧会话条目。单个目录不支持两个同时活动的 Studio 实例。

组 revision 由基本音符字段和支持的参数曲线规范 JSON 计算，包含两个 32 位哈希和字节长度，用于乐观并发校验，不是安全签名。它可发现手工编辑和其他 Agent 的已完成修改；未暴露的声库、属性和宿主内部状态不在该版本范围内。

## 常见错误

| code | 处理 |
| --- | --- |
| BRIDGE_OFFLINE | 启动桥接，检查路径和心跳；若是已发布调用中断，先查询原 ID |
| SESSION_CHANGED / PROJECT_CHANGED | 重新检查目标工程，重新读取 |
| REVISION_CONFLICT / TRACK_CONFLICT | 重新读取并评估当前状态 |
| REQUEST_ID_CONFLICT | 使用原载荷查询/重试；新的操作使用新 ID |
| REQUEST_TIMEOUT / REQUEST_CANCELLED | 检查原 ID；不能直接假定没有编辑 |
| REQUEST_EXPIRED | 执行前已过期，重新读取后决定是否发起新操作 |
| INDETERMINATE | 检查工程或使用 UI 撤销，禁止自动重做 |
| INVALID_ARGUMENT / UNKNOWN_METHOD | 修正调用，校验失败没有开始宿主编辑 |
| HOST_ERROR | 检查 mayHaveApplied；为 true 时宿主可能已部分修改 |
| REPLY_MISMATCH / PROTOCOL_ERROR | 修复通信文件/版本问题，不把该回复当成成功 |

历史文件不会自动删除，以保留去重和故障调查依据。停止全部相关进程后可以归档整个通信目录；重新初始化后启动新会话。不要只删除去重记录而继续使用同一个会话。
