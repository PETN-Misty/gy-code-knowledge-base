---
name: gy-ai-chat
description: 启动 GY 代码知识库并与 AI 代码解析助手对话。可启动服务器、创建会话、发送代码让 AI 解析、查看历史对话。
---

# GY AI 代码解析助手

启动项目并与 AI 对话。先确保服务器在运行，然后通过聊天 API 与 AI 交互。

## 步骤

### 1. 启动服务器（如果未运行）

```bash
cd "C:\Users\li\Desktop\26-6\demo2\projects\gy-code-knowledge-base"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ || node server.js &
sleep 3
```

检查是否启动成功：
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# 返回 200 表示成功
```

### 2. 创建新对话

```bash
curl -s -X POST http://localhost:3000/api/chat/sessions \
  -H "Content-Type: application/json" \
  -d '{"title": "代码解析"}'
# 返回: {"success":true,"data":{"id":1,"title":"代码解析"}}
```

记录返回的 `id`，后续用此 ID 发送消息。

### 3. 发送代码给 AI 解析

```bash
SESSION_ID=1  # 替换为实际会话 ID
curl -s -X POST "http://localhost:3000/api/chat/sessions/$SESSION_ID/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "请解析这段代码：\n```python\ndef fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)\n```"}'
# 返回 AI 解析结果 + promptInfo（含 system prompt 记录）
```

### 4. 继续多轮对话（同一会话）

```bash
curl -s -X POST "http://localhost:3000/api/chat/sessions/$SESSION_ID/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "能优化成迭代版本吗？"}'
# AI 保留上下文，继续回答
```

### 5. 查看历史对话

```bash
# 列出所有会话
curl -s http://localhost:3000/api/chat/sessions

# 查看某会话的完整消息历史
curl -s http://localhost:3000/api/chat/sessions/$SESSION_ID/messages
# 每条消息带 prompt_info 字段，记录当时调 AI 用的完整提示词
```

### 6. 其他 API

```bash
# 代码搜索
curl -s -X POST http://localhost:3000/api/ai/search \
  -H "Content-Type: application/json" \
  -d '{"query":"找排序算法的代码"}'

# RAG 知识库问答
curl -s -X POST http://localhost:3000/api/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"这个项目怎么用？"}'
```

## 注意事项

- 服务器需要 MySQL 8.0 在运行
- AI 使用 DeepSeek V4 Flash 模型，需在 `.env` 中配置 API Key
- 对话数据持久化在 MySQL 的 `chat_sessions` 和 `chat_messages` 表
- 每条 AI 回复都记录完整 prompt_info，可通过 `🧠` 按钮或 API 查看
