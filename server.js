const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

// 加载 .env 配置（必须放在所有使用之前）
require('dotenv').config();

const app = express();
const PORT = 3000;

// 解析 JSON 请求体
app.use(express.json());

// ==================== GY 水印中间件 ====================
// 在所有 JSON 响应中注入 watermark 字段
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body.watermark = 'GY';
    }
    return originalJson(body);
  };
  next();
});

// MySQL 连接配置
const DB_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'api_user',
  password: 'api_pass_2024',
  database: 'user_api',
  waitForConnections: true,
  charset: 'utf8mb4',
};

let pool;

// ---------- 工具函数 ----------

/**
 * 安全地给表名/列名加反引号（防 SQL 注入）
 */
function quoteId(id) {
  return '`' + String(id).replace(/`/g, '``') + '`';
}

/**
 * 缓存表结构，避免每次请求都查询 INFORMATION_SCHEMA
 * key = 表名, value = { columns: [], primaryKey: string }
 */
const schemaCache = new Map();

/**
 * 获取表的列信息和主键
 */
async function getTableSchema(table) {
  const cached = schemaCache.get(table);
  if (cached) return cached;

  const [cols] = await pool.execute(
    `SELECT COLUMN_NAME, COLUMN_KEY, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [DB_CONFIG.database, table]
  );

  if (cols.length === 0) {
    return null; // 表不存在
  }

  const columns = cols.map(c => ({
    name: c.COLUMN_NAME,
    type: c.DATA_TYPE,
    nullable: c.IS_NULLABLE === 'YES',
    default: c.COLUMN_DEFAULT,
    autoIncrement: c.EXTRA && c.EXTRA.includes('auto_increment'),
    isPrimary: c.COLUMN_KEY === 'PRI',
  }));

  const pk = columns.find(c => c.isPrimary);
  const primaryKey = pk ? pk.name : null;

  const schema = { columns, primaryKey };
  schemaCache.set(table, schema);
  return schema;
}

/**
 * 校验表名是否合法且存在
 */
async function validateTable(table) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    return { valid: false, status: 400, message: `非法表名: ${table}` };
  }
  const schema = await getTableSchema(table);
  if (!schema) {
    return { valid: false, status: 404, message: `表 ${table} 不存在` };
  }
  return { valid: true, schema };
}

/**
 * 从查询参数构建 WHERE 子句（自动匹配列名）
 * 例如 ?name=张三&minAge=20 → WHERE name LIKE ? AND age >= ?
 */
function buildWhereFromQuery(query, schema) {
  const clauses = [];
  const params = [];
  const columnNames = new Set(schema.columns.map(c => c.name));

  for (const [key, value] of Object.entries(query)) {
    // 范围查询: minAge, maxAge → age >= ?, age <= ?
    const rangeMatch = key.match(/^(min|max)(.+)$/i);
    if (rangeMatch) {
      const op = rangeMatch[1].toLowerCase() === 'min' ? '>=' : '<=';
      const col = rangeMatch[2];
      // 首字母小写转驼峰 → 原列名（用户传 minAge 匹配 age 列）
      const colName = col.charAt(0).toLowerCase() + col.slice(1);
      if (columnNames.has(colName)) {
        clauses.push(`${quoteId(colName)} ${op} ?`);
        params.push(Number(value) || value);
      }
      continue;
    }

    if (columnNames.has(key)) {
      const colSchema = schema.columns.find(c => c.name === key);
      // 数字类型用精确匹配，字符串类型用 LIKE
      if (['int', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal'].includes(colSchema?.type)) {
        clauses.push(`${quoteId(key)} = ?`);
        params.push(Number(value));
      } else {
        clauses.push(`${quoteId(key)} LIKE ?`);
        params.push(`%${value}%`);
      }
    }
  }

  return { clauses, params };
}

/**
 * 清除表结构缓存（建表/删表后调用）
 */
function clearSchemaCache(table) {
  if (table) schemaCache.delete(table);
  else schemaCache.clear();
}

// ==================== AI 智能搜索 (DeepSeek V4 Flash) ====================

const AI_CONFIG = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
};

/**
 * 获取所有表的结构描述，发给 AI 做上下文
 */
async function getSchemaContext() {
  const [tables] = await pool.execute(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [DB_CONFIG.database]
  );
  const descs = [];
  for (const t of tables) {
    const schema = await getTableSchema(t.TABLE_NAME);
    if (!schema) continue;
    const cols = schema.columns.map(c =>
      `  - ${c.name} (${c.type})${c.isPrimary ? ' [主键]' : ''}${c.nullable ? ' 可空' : ' 必填'}${c.autoIncrement ? ' 自增' : ''}`
    ).join('\n');
    descs.push(`表 ${t.TABLE_NAME}:\n${cols}`);
  }
  return descs.join('\n\n');
}

/**
 * 调用 DeepSeek API
 */
async function callDeepSeek(messages, options = {}) {
  const { stream = false, temperature = 0.1, max_tokens = 2000 } = options;

  if (!AI_CONFIG.apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY，请在 .env 文件中设置');
  }

  const res = await fetch(`${AI_CONFIG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: AI_CONFIG.model,
      messages,
      stream,
      temperature,
      max_tokens,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API 错误 [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * POST /api/ai/search
 * 自然语言查询数据库
 * 请求: { query: "找30岁以上的用户", table?: "users" }
 * 返回: { sql, data, answer }
 */
app.post('/api/ai/search', async (req, res) => {
  try {
    const { query, table: targetTable } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ success: false, message: '请输入查询内容' });
    }

    // 1. 获取数据库结构上下文
    const schemaContext = await getSchemaContext();

    // 2. 构建 AI 提示词
    const systemPrompt = `你是一个代码知识库查询助手。数据库包含以下表：

${schemaContext}

请根据用户的问题生成 SQL 查询语句。
要求：
- 只生成 SELECT 查询，不要修改数据
- 列名用反引号包裹，表名用反引号包裹
- 字符串用单引号
- 用户会问代码相关的问题（如"找排序算法的例子"、"Python的异步编程示例"）
- 用 language、tags、difficulty 列做筛选
- SQL 末尾加分号
- 如果问题无法用 SQL 表达，给出解释

回复格式（严格 JSON，不要多余文字）：
{
  "sql": "生成的 SQL",
  "tables": ["涉及的表名"],
  "explanation": "对查询逻辑的简短解释"
}`;

    const userMessage = targetTable
      ? `在表 ${targetTable} 中：${query}`
      : query;

    // 3. 调 AI 生成 SQL
    const aiReply = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], { temperature: 0.05 });

    // 4. 解析 AI 返回的 JSON
    let parsed;
    try {
      const jsonMatch = aiReply.match(/```(?:json)?\s*([\s\S]*?)```/) || aiReply.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : aiReply;
      parsed = JSON.parse(jsonStr.trim());
    } catch {
      return res.status(500).json({
        success: false,
        message: 'AI 返回格式异常，请重试',
        raw: aiReply,
      });
    }

    if (!parsed.sql) {
      return res.json({
        success: true,
        message: 'AI 分析结果',
        explanation: parsed.explanation || aiReply,
        data: [],
        sql: null,
        watermark: 'GY',
      });
    }

    // 5. 校验：只允许 SELECT
    const sqlTrim = parsed.sql.trim().toUpperCase();
    if (!sqlTrim.startsWith('SELECT')) {
      return res.status(400).json({
        success: false,
        message: 'AI 生成的不是查询语句，已拦截',
        sql: parsed.sql,
      });
    }

    // 6. 执行 SQL
    const [rows] = await pool.execute(parsed.sql);
    const count = rows.length;

    // 7. 用 AI 总结结果（简短）
    let answer = '';
    if (count > 0 && count <= 50) {
      const summaryPrompt = `数据库查询结果如下，请用一句话总结（20字以内）：

问题：${query}
SQL：${parsed.sql}
结果：${JSON.stringify(rows.slice(0, 5))}
共 ${count} 条记录`;

      answer = await callDeepSeek([
        { role: 'system', content: '你是一个简洁的数据分析师，用一句话总结查询结果。' },
        { role: 'user', content: summaryPrompt },
      ], { temperature: 0.3, max_tokens: 100 });
    } else if (count > 50) {
      answer = `共查询到 ${count} 条记录，数据较多，请查看下方完整列表。`;
    } else {
      answer = '未查询到符合条件的记录。';
    }

    res.json({
      success: true,
      question: query,
      sql: parsed.sql,
      explanation: parsed.explanation || '',
      answer: answer.trim(),
      count,
      data: rows,
      watermark: 'GY',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'AI 查询失败',
      error: err.message,
      watermark: 'GY',
    });
  }
});

// ==================== RAG 知识库 (DeepSeek V4 Flash) ====================

/**
 * 文本分块：按段落和句子切分，每块约 500 字，块间重叠 50 字
 */
function chunkText(text, maxLen = 500, overlap = 50) {
  // 先按段落拆分
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  const chunks = [];
  let buffer = '';

  for (const para of paragraphs) {
    if ((buffer + para).length <= maxLen) {
      buffer += (buffer ? '\n\n' : '') + para;
    } else {
      if (buffer) chunks.push(buffer.trim());
      // 长段落按句子切分
      if (para.length > maxLen) {
        const sentences = para.split(/(?<=[。！？.!?])/);
        buffer = '';
        for (const sent of sentences) {
          if ((buffer + sent).length > maxLen) {
            if (buffer) chunks.push(buffer.trim());
            buffer = sent;
          } else {
            buffer += sent;
          }
        }
      } else {
        buffer = para;
      }
    }
  }
  if (buffer) chunks.push(buffer.trim());

  // 去重
  return [...new Set(chunks)];
}

/**
 * POST /api/rag/documents
 * 上传文档到知识库
 * 请求: { title: string, content: string, source?: string }
 */
app.post('/api/rag/documents', async (req, res) => {
  try {
    const { title, content, source } = req.body;

    if (!title || !content) {
      return res.status(400).json({ success: false, message: '请提供 title 和 content' });
    }

    const chunks = chunkText(content);

    let inserted = 0;
    for (let i = 0; i < chunks.length; i++) {
      await pool.execute(
        'INSERT INTO knowledge_chunks (title, chunk_text, chunk_index, source) VALUES (?, ?, ?, ?)',
        [title.trim(), chunks[i], i, source || '']
      );
      inserted++;
    }

    res.status(201).json({
      success: true,
      message: `文档「${title}」已导入，共 ${inserted} 个知识块`,
      chunks: inserted,
      watermark: 'GY',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '导入失败', error: err.message, watermark: 'GY' });
  }
});

/**
 * GET /api/rag/documents
 * 列出知识库中的所有文档（按标题去重）
 */
app.get('/api/rag/documents', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT title, source, COUNT(*) AS chunks, MAX(created_at) AS updated_at
      FROM knowledge_chunks
      GROUP BY title, source
      ORDER BY updated_at DESC
    `);

    const [total] = await pool.execute('SELECT COUNT(*) AS total FROM knowledge_chunks');

    res.json({
      success: true,
      count: rows.length,
      totalChunks: total[0].total,
      data: rows,
      watermark: 'GY',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询失败', error: err.message, watermark: 'GY' });
  }
});

/**
 * DELETE /api/rag/documents/:title
 * 删除指定文档
 */
app.delete('/api/rag/documents/:title', async (req, res) => {
  try {
    const { title } = req.params;
    const [result] = await pool.execute('DELETE FROM knowledge_chunks WHERE title = ?', [title]);

    res.json({
      success: true,
      message: `已删除文档「${title}」(${result.affectedRows} 个知识块)`,
      affectedRows: result.affectedRows,
      watermark: 'GY',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除失败', error: err.message, watermark: 'GY' });
  }
});

/**
 * POST /api/rag/ask
 * RAG 问答：检索知识库 → DeepSeek 生成回答
 * 请求: { query: string, topK?: number }
 */
app.post('/api/rag/ask', async (req, res) => {
  try {
    const { query, topK = 5 } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ success: false, message: '请输入问题' });
    }

    // 1. 全文检索：用 MySQL FULLTEXT 搜索最相关的知识块
    const cleanQuery = query.replace(/[^一-龥a-zA-Z0-9\s]/g, ' ');
    let chunks = [];

    if (cleanQuery.trim()) {
      const limit = Math.min(topK * 2, 20);
      const sql =
        `SELECT id, title, chunk_text, source, chunk_index,
                MATCH(chunk_text) AGAINST(?) AS relevance
         FROM knowledge_chunks
         WHERE MATCH(chunk_text) AGAINST(?)
         ORDER BY relevance DESC
         LIMIT ${limit}`;
      const [rows] = await pool.query(sql, [cleanQuery, cleanQuery]);
      chunks = rows;
    }

    // 如果全文检索没结果，用 LIKE 模糊匹配兜底
    if (chunks.length === 0) {
      const fallbackLimit = Math.min(topK * 2, 20);
      const [rows] = await pool.execute(
        `SELECT id, title, chunk_text, source, chunk_index, 0 AS relevance
         FROM knowledge_chunks
         WHERE chunk_text LIKE ? OR chunk_text LIKE ? OR chunk_text LIKE ?
         LIMIT ${fallbackLimit}`,
        [`%${query}%`, `%${query.slice(0, 10)}%`, `%${query.slice(0, 5)}%`]
      );
      chunks = rows;
    }

    // 2. 如果知识库为空，引导用户上传文档
    const [totalChunks] = await pool.execute('SELECT COUNT(*) AS c FROM knowledge_chunks');
    if (totalChunks[0].c === 0) {
      return res.json({
        success: true,
        answer: '📚 知识库还没有内容。请先上传文档（POST /api/rag/documents），我才能回答你的问题。',
        sourceDocs: [],
        watermark: 'GY',
      });
    }

    // 3. 用 DeepSeek 对 chunks 做相关性重排序（取 topK）
    let contextChunks = chunks.slice(0, Math.min(topK, chunks.length));

    if (chunks.length > topK) {
      // 让 AI 选出最相关的 chunks
      const rerankPrompt = `从以下知识块中选出与问题最相关的 ${topK} 条（只返回序号，逗号分隔）：

问题：${query}

${chunks.map((c, i) => `[${i}] ${c.chunk_text.slice(0, 200)}`).join('\n\n')}`;

      try {
        const rerankResult = await callDeepSeek([
          { role: 'system', content: '你是一个检索排序助手。根据问题相关性，选出最相关的知识块序号，只返回数字（逗号分隔）。' },
          { role: 'user', content: rerankPrompt },
        ], { temperature: 0.05, max_tokens: 100 });

        const indices = rerankResult.match(/\d+/g)?.map(Number).filter(i => i < chunks.length).slice(0, topK);
        if (indices && indices.length > 0) {
          contextChunks = indices.map(i => chunks[i]);
        }
      } catch {
        // 重排序失败，直接用前 topK 条
      }
    }

    // 4. 拼 context → 调 DeepSeek 生成回答
    const context = contextChunks.map(c =>
      `【来源：${c.source || c.title}】${c.chunk_text}`
    ).join('\n\n');

    const answerPrompt = `你是一个知识库问答助手。请基于以下参考资料回答问题。

参考资料：
${context}

问题：${query}

要求：
- 如果参考资料足够，给出详细准确的回答
- 如果参考资料不足以回答问题，明确说"资料中未找到相关信息"
- 引用具体来源
- 回答简洁有条理，用中文`;

    const answer = await callDeepSeek([
      { role: 'system', content: '你是基于知识库的问答助手，回答简洁准确，引用来源。' },
      { role: 'user', content: answerPrompt },
    ], { temperature: 0.3, max_tokens: 1000 });

    // 5. 返回
    res.json({
      success: true,
      question: query,
      answer: answer.trim(),
      sourceDocs: contextChunks.map(c => ({
        title: c.title,
        source: c.source,
        snippet: c.chunk_text.slice(0, 150),
        relevance: c.relevance || null,
      })),
      chunksUsed: contextChunks.length,
      watermark: 'GY',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'RAG 问答失败',
      error: err.message,
      watermark: 'GY',
    });
  }
});

// ==================== 静态页面 ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(__dirname));

// ==================== 通用 CRUD 路由 ====================

/**
 * GET /api/tables
 * 列出数据库中所有表
 */
app.get('/api/tables', async (req, res) => {
  try {
    const [tables] = await pool.execute(
      'SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME, TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [DB_CONFIG.database]
    );

    const result = await Promise.all(
      tables.map(async (t) => {
        const schema = await getTableSchema(t.TABLE_NAME);
        return {
          name: t.TABLE_NAME,
          rows: t.TABLE_ROWS,
          created: t.CREATE_TIME,
          comment: t.TABLE_COMMENT,
          columns: schema?.columns.map(c => ({ name: c.name, type: c.type, nullable: c.nullable })) || [],
        };
      })
    );

    res.json({ success: true, count: result.length, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询表列表失败', error: err.message });
  }
});

/**
 * GET /api/tables/:table/schema
 * 获取表的列结构
 */
app.get('/api/tables/:table/schema', async (req, res) => {
  try {
    const { table } = req.params;
    const check = await validateTable(table);
    if (!check.valid) return res.status(check.status).json({ success: false, message: check.message });

    res.json({ success: true, data: check.schema });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询表结构失败', error: err.message });
  }
});

/**
 * POST /api/tables
 * 创建新表
 * 请求体: { tableName: string, columns: [{ name, type, ... }] }
 * 或直接传 SQL 片段
 */
app.post('/api/tables', async (req, res) => {
  try {
    const { tableName, columns } = req.body;

    if (!tableName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      return res.status(400).json({ success: false, message: '无效的表名' });
    }
    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ success: false, message: '请提供 columns 数组' });
    }

    // 建表
    const colDefs = columns.map(col => {
      let def = `${quoteId(col.name)} ${col.type}`;
      if (col.notNull) def += ' NOT NULL';
      if (col.default !== undefined) def += ` DEFAULT ${typeof col.default === 'string' ? `'${col.default}'` : col.default}`;
      if (col.autoIncrement) def += ' AUTO_INCREMENT';
      if (col.comment) def += ` COMMENT '${col.comment}'`;
      if (col.primaryKey) def += ' PRIMARY KEY';
      if (col.unique) def += ' UNIQUE';
      return def;
    });

    const sql = `CREATE TABLE ${quoteId(tableName)} (${colDefs.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
    await pool.execute(sql);
    clearSchemaCache(tableName);

    res.status(201).json({ success: true, message: `表 ${tableName} 创建成功` });
  } catch (err) {
    res.status(500).json({ success: false, message: '创建表失败', error: err.message });
  }
});

// ---- 通用行数据 CRUD ----

/**
 * GET /api/:table
 * 查询表数据，支持筛选、排序、分页
 *   ?col=val           - 字符串 LIKE 查询，数字精确匹配
 *   ?minCol=N&maxCol=N - 范围查询
 *   ?_sort=col         - 排序列（默认主键）
 *   ?_order=ASC|DESC   - 排序方向（默认 ASC）
 *   ?_page=1&_size=20  - 分页（默认 _page=1, _size=50）
 */
app.get('/api/:table', async (req, res) => {
  try {
    const { table } = req.params;
    const check = await validateTable(table);
    if (!check.valid) return res.status(check.status).json({ success: false, message: check.message });

    const { _sort, _order, _page, _size, ...filters } = req.query;
    const schema = check.schema;

    // 构建 WHERE
    const { clauses, params } = buildWhereFromQuery(filters, schema);
    const whereSQL = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';

    // 排序
    const sortCol = _sort && schema.columns.find(c => c.name === _sort) ? _sort : (schema.primaryKey || schema.columns[0].name);
    const sortDir = _order && _order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // 分页
    const page = Math.max(1, parseInt(_page) || 1);
    const size = Math.min(200, Math.max(1, parseInt(_size) || 50));
    const offset = (page - 1) * size;

    // 查询总数
    const countSQL = `SELECT COUNT(*) AS total FROM ${quoteId(table)} ${whereSQL}`;
    const [countResult] = params.length > 0
      ? await pool.query(countSQL, params)
      : await pool.query(countSQL);
    const total = countResult[0].total;

    // 查询数据
    const dataSQL = `SELECT * FROM ${quoteId(table)} ${whereSQL} ORDER BY ${quoteId(sortCol)} ${sortDir} LIMIT ${Number(size)} OFFSET ${Number(offset)}`;
    const [rows] = await pool.query(dataSQL, params);

    res.json({
      success: true,
      table,
      count: rows.length,
      total,
      page,
      size,
      totalPages: Math.ceil(total / size),
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询数据失败', error: err.message });
  }
});

/**
 * GET /api/:table/:id
 * 根据主键获取单条记录
 */
app.get('/api/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;
    const check = await validateTable(table);
    if (!check.valid) return res.status(check.status).json({ success: false, message: check.message });

    const pk = check.schema.primaryKey;
    if (!pk) return res.status(400).json({ success: false, message: `表 ${table} 没有主键，无法按 ID 查询` });

    const [rows] = await pool.execute(`SELECT * FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: `记录不存在（${pk}=${id}）` });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询数据失败', error: err.message });
  }
});

/**
 * POST /api/:table
 * 插入记录。请求体为 JSON 对象 { col: value, ... }
 */
app.post('/api/:table', async (req, res) => {
  try {
    const { table } = req.params;
    const check = await validateTable(table);
    if (!check.valid) return res.status(check.status).json({ success: false, message: check.message });

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, message: '请求体必须是 JSON 对象' });
    }

    // 只插入表中存在的列，过滤掉未知字段
    const colNames = check.schema.columns.map(c => c.name);
    const entries = Object.entries(body).filter(([k]) => colNames.includes(k));

    if (entries.length === 0) {
      return res.status(400).json({ success: false, message: '没有有效的列数据' });
    }

    const cols = entries.map(([k]) => quoteId(k));
    const placeholders = entries.map(() => '?');
    const values = entries.map(([, v]) => v);

    const [result] = await pool.execute(
      `INSERT INTO ${quoteId(table)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );

    // 查询刚插入的记录
    const pk = check.schema.primaryKey;
    let inserted = null;
    if (pk && result.insertId) {
      const [rows] = await pool.execute(`SELECT * FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`, [result.insertId]);
      inserted = rows[0];
    }

    res.status(201).json({
      success: true,
      message: '记录创建成功',
      affectedRows: result.affectedRows,
      insertId: result.insertId,
      data: inserted,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: '数据冲突（违反唯一约束）', error: err.message });
    }
    res.status(500).json({ success: false, message: '创建记录失败', error: err.message });
  }
});

/**
 * PUT /api/:table/:id
 * 根据主键更新记录。请求体为 JSON 对象 { col: value, ... }
 */
app.put('/api/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;
    const check = await validateTable(table);
    if (!check.valid) return res.status(check.status).json({ success: false, message: check.message });

    const pk = check.schema.primaryKey;
    if (!pk) return res.status(400).json({ success: false, message: `表 ${table} 没有主键，无法按 ID 更新` });

    // 检查记录是否存在
    const [existing] = await pool.execute(`SELECT * FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`, [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: `记录不存在（${pk}=${id}）` });

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, message: '请求体必须是 JSON 对象' });
    }

    // 只更新表中存在的列，跳过主键和自增列
    const pkName = pk;
    const colNames = check.schema.columns.map(c => c.name);
    const autoCols = new Set(check.schema.columns.filter(c => c.autoIncrement).map(c => c.name));

    const entries = Object.entries(body).filter(([k]) => colNames.includes(k) && k !== pkName && !autoCols.has(k));

    if (entries.length === 0) {
      return res.status(400).json({ success: false, message: '没有有效的更新字段' });
    }

    const setClauses = entries.map(([k]) => `${quoteId(k)} = ?`);
    const values = [...entries.map(([, v]) => v), id];

    await pool.execute(
      `UPDATE ${quoteId(table)} SET ${setClauses.join(', ')} WHERE ${quoteId(pk)} = ?`,
      values
    );

    // 返回更新后的记录
    const [updated] = await pool.execute(`SELECT * FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`, [id]);

    res.json({
      success: true,
      message: '记录更新成功',
      data: updated[0],
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: '数据冲突（违反唯一约束）', error: err.message });
    }
    res.status(500).json({ success: false, message: '更新记录失败', error: err.message });
  }
});

/**
 * PATCH /api/:table/:id
 * 部分更新（与 PUT 行为一致，语义更准确）
 */
app.patch('/api/:table/:id', async (req, res) => {
  req.params = req.params; // 复用 PUT 逻辑
  // 直接转发到 PUT 的处理函数
  const handler = app.routes.find(r => r.method === 'PUT' && r.path === '/api/:table/:id')?.handler;
  if (handler) return handler(req, res);
  res.status(500).json({ success: false, message: '内部错误' });
});

/**
 * DELETE /api/:table/:id
 * 根据主键删除记录
 */
app.delete('/api/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;
    const check = await validateTable(table);
    if (!check.valid) return res.status(check.status).json({ success: false, message: check.message });

    const pk = check.schema.primaryKey;
    if (!pk) return res.status(400).json({ success: false, message: `表 ${table} 没有主键，无法按 ID 删除` });

    const [existing] = await pool.execute(`SELECT * FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`, [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: `记录不存在（${pk}=${id}）` });

    await pool.execute(`DELETE FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`, [id]);

    res.json({
      success: true,
      message: '记录删除成功',
      data: existing[0],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除记录失败', error: err.message });
  }
});

// ==================== 建表 & 启动 ====================

async function initDatabase() {
  // 确保数据库存在
  const initConn = await mysql.createConnection({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
  });
  await initConn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await initConn.end();

  pool = mysql.createPool(DB_CONFIG);

  // ----- 代码片段表 code_snippets -----
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS code_snippets (
      id          INT             NOT NULL AUTO_INCREMENT,
      title       VARCHAR(200)    NOT NULL COMMENT '代码标题',
      language    VARCHAR(50)     NOT NULL COMMENT '编程语言',
      code        TEXT            NOT NULL COMMENT '代码内容',
      description TEXT            NULL     COMMENT '说明',
      tags        VARCHAR(500)    NULL     COMMENT '标签（逗号分隔）',
      difficulty  VARCHAR(20)     DEFAULT 'beginner' COMMENT 'beginner / intermediate / advanced',
      source      VARCHAR(200)    DEFAULT '' COMMENT '来源',
      created_at  DATETIME        DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      FULLTEXT INDEX ft_code (code, description, title)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [snippetCount] = await pool.execute('SELECT COUNT(*) AS count FROM code_snippets');
  if (snippetCount[0].count === 0) {
    await pool.execute(
      `INSERT INTO code_snippets (title, language, code, description, tags, difficulty, source) VALUES
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?)`,
      [
        '冒泡排序', 'Python',
        `def bubble_sort(arr):
    """冒泡排序算法"""
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr

# 使用示例
data = [64, 34, 25, 12, 22, 11, 90]
print(bubble_sort(data))`,
        '经典的冒泡排序算法实现', '排序,算法,基础', 'beginner', '示例',

        'Promise 链式调用', 'JavaScript',
        `// Promise 链式调用示例
function fetchUser(id) {
  return fetch(\`https://api.example.com/users/\${id}\`)
    .then(res => res.json());
}

function fetchPosts(userId) {
  return fetch(\`https://api.example.com/users/\${userId}/posts\`)
    .then(res => res.json());
}

// 链式调用
fetchUser(1)
  .then(user => {
    console.log('用户:', user.name);
    return fetchPosts(user.id);
  })
  .then(posts => {
    console.log('文章:', posts.length);
  })
  .catch(err => console.error('错误:', err));`,
        '使用 Promise 进行链式异步调用', '异步,Promise,API', 'intermediate', '示例',

        'goroutine 并发', 'Go',
        `package main

import (
    "fmt"
    "time"
)

func worker(id int, jobs <-chan int, results chan<- int) {
    for job := range jobs {
        fmt.Printf("Worker %d 开始任务 %d\\n", id, job)
        time.Sleep(time.Second)
        results <- job * 2
    }
}

func main() {
    jobs := make(chan int, 5)
    results := make(chan int, 5)

    // 启动 3 个 worker
    for w := 1; w <= 3; w++ {
        go worker(w, jobs, results)
    }

    // 发送 5 个任务
    for j := 1; j <= 5; j++ {
        jobs <- j
    }
    close(jobs)

    // 收集结果
    for r := 1; r <= 5; r++ {
        <-results
    }
}`,
        'Go 并发编程：使用 goroutine 和 channel', '并发,goroutine,channel', 'advanced', '示例',

        '二分查找', 'TypeScript',
        `function binarySearch<T extends number>(arr: T[], target: T): number {
  let left = 0;
  let right = arr.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);

    if (arr[mid] === target) {
      return mid; // 找到目标
    } else if (arr[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return -1; // 未找到
}

// 测试
const sortedArr = [1, 3, 5, 7, 9, 11, 13];
const index = binarySearch(sortedArr, 7);
console.log(\`目标索引: \${index}\`);`,
        'TypeScript 实现的二分查找算法', '算法,查找,二分', 'intermediate', '示例',

        'HashMap 遍历', 'Java',
        `import java.util.*;

public class HashMapExample {
    public static void main(String[] args) {
        Map<String, Integer> scores = new HashMap<>();
        scores.put("Alice", 95);
        scores.put("Bob", 87);
        scores.put("Charlie", 92);

        // 方式 1: for-each + entrySet
        System.out.println("=== entrySet 遍历 ===");
        for (Map.Entry<String, Integer> entry : scores.entrySet()) {
            System.out.println(entry.getKey() + ": " + entry.getValue());
        }

        // 方式 2: forEach (Java 8+)
        System.out.println("=== forEach 遍历 ===");
        scores.forEach((name, score) ->
            System.out.println(name + ": " + score)
        );

        // 方式 3: keySet 遍历
        System.out.println("=== keySet 遍历 ===");
        for (String name : scores.keySet()) {
            System.out.println(name + ": " + scores.get(name));
        }
    }
}`,
        'Java HashMap 的三种遍历方式', '集合,Map,遍历', 'beginner', '示例',

        '闭包示例', 'JavaScript',
        `// 闭包：函数保留对其外部作用域的引用
function createCounter() {
  let count = 0;

  return {
    increment() {
      count++;
      return count;
    },
    decrement() {
      count--;
      return count;
    },
    getCount() {
      return count;
    }
  };
}

const counter = createCounter();
console.log(counter.increment()); // 1
console.log(counter.increment()); // 2
console.log(counter.decrement()); // 1
console.log(counter.getCount());  // 1

// 实用场景：函数工厂
function multiply(factor) {
  return function(number) {
    return number * factor;
  };
}

const double = multiply(2);
const triple = multiply(3);
console.log(double(5)); // 10
console.log(triple(5)); // 15`,
        'JavaScript 闭包的概念与实用场景', '闭包,函数式,作用域', 'intermediate', '示例',

        'trait 接口', 'Rust',
        `// 定义 trait
trait Animal {
    fn name(&self) -> &str;
    fn speak(&self) -> String;

    // 默认实现
    fn description(&self) -> String {
        format!("{} says {}", self.name(), self.speak())
    }
}

// 实现 trait
struct Dog {
    name: String,
}

impl Animal for Dog {
    fn name(&self) -> &str {
        &self.name
    }
    fn speak(&self) -> String {
        "Woof!".to_string()
    }
}

struct Cat {
    name: String,
}

impl Animal for Cat {
    fn name(&self) -> &str {
        &self.name
    }
    fn speak(&self) -> String {
        "Meow!".to_string()
    }
}

fn main() {
    let dog = Dog { name: "Buddy".to_string() };
    let cat = Cat { name: "Kitty".to_string() };

    println!("{}", dog.description());
    println!("{}", cat.description());
}`,
        'Rust trait 接口的定义与实现', 'trait,泛型,接口', 'advanced', '示例',

        'Stream API (LINQ)', 'C#',
        `using System;
using System.Collections.Generic;
using System.Linq;

class Program {
    static void Main() {
        var students = new List<Student> {
            new Student { Name = "Alice", Score = 85, Age = 20 },
            new Student { Name = "Bob",   Score = 92, Age = 22 },
            new Student { Name = "Carol", Score = 78, Age = 19 },
            new Student { Name = "David", Score = 95, Age = 21 },
        };

        // LINQ 查询：筛选 + 排序 + 投影
        var result = students
            .Where(s => s.Score >= 80)
            .OrderByDescending(s => s.Score)
            .Select(s => $"{s.Name}: {s.Score}分 (年龄{s.Age})");

        Console.WriteLine("优秀学生：");
        foreach (var item in result) {
            Console.WriteLine("  " + item);
        }

        // 聚合操作
        Console.WriteLine($"\\n平均分: {students.Average(s => s.Score):F1}");
        Console.WriteLine($"最高分: {students.Max(s => s.Score)}");
    }
}

class Student {
    public string Name { get; set; }
    public int Score { get; set; }
    public int Age { get; set; }
}`,
        'C# LINQ (Stream API) 数据查询与处理', 'LINQ,集合,查询', 'intermediate', '示例',
      ]
    );
    console.log('✅ 已插入 code_snippets 示例数据（8 个代码片段）');
  }

  // ----- 编程语言表 languages -----
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS languages (
      id          INT          NOT NULL AUTO_INCREMENT,
      name        VARCHAR(50)  NOT NULL UNIQUE COMMENT '语言名称',
      extension   VARCHAR(20)  NULL     COMMENT '文件扩展名',
      sort_order  INT          DEFAULT 0 COMMENT '排序',
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [langCount] = await pool.execute('SELECT COUNT(*) AS count FROM languages');
  if (langCount[0].count === 0) {
    await pool.execute(
      `INSERT INTO languages (name, extension, sort_order) VALUES
       ('JavaScript', '.js', 1),
       ('TypeScript', '.ts', 2),
       ('Python', '.py', 3),
       ('Java', '.java', 4),
       ('Go', '.go', 5),
       ('Rust', '.rs', 6),
       ('C++', '.cpp', 7),
       ('C#', '.cs', 8),
       ('PHP', '.php', 9),
       ('Ruby', '.rb', 10),
       ('Swift', '.swift', 11),
       ('Kotlin', '.kt', 12)`
    );
    console.log('✅ 已插入 languages 示例数据（12 种语言）');
  }

  // ----- RAG 知识库表 -----
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id          INT             NOT NULL AUTO_INCREMENT,
      title       VARCHAR(500)    NOT NULL,
      chunk_text  TEXT            NOT NULL,
      chunk_index INT             DEFAULT 0,
      source      VARCHAR(200)    DEFAULT '',
      created_at  DATETIME        DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      FULLTEXT INDEX ft_chunk_text (chunk_text)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 检查是否有示例知识库数据
  const [kbCount] = await pool.execute('SELECT COUNT(*) AS count FROM knowledge_chunks');
  if (kbCount[0].count === 0) {
    await pool.execute(
      'INSERT INTO knowledge_chunks (title, chunk_text, chunk_index, source) VALUES (?, ?, ?, ?)',
      ['GY 代码知识库简介', 'GY·代码知识库是一个基于Express和MySQL的编程学习工具，支持存储和管理各种编程语言的代码片段，内置AI智能搜索和RAG知识库问答功能，方便开发者学习和查阅代码。', 0, '说明']
    );
    await pool.execute(
      'INSERT INTO knowledge_chunks (title, chunk_text, chunk_index, source) VALUES (?, ?, ?, ?)',
      ['GY 代码知识库技术栈', '本项目使用Node.js + Express 5作为Web框架，MySQL 8.0作为数据库，mysql2作为数据库驱动。AI功能接入DeepSeek V4 Flash API，支持自然语言搜索代码和基于知识库的智能问答。', 0, '说明']
    );
    await pool.execute(
      'INSERT INTO knowledge_chunks (title, chunk_text, chunk_index, source) VALUES (?, ?, ?, ?)',
      ['代码知识库使用方式', '可以通过网页界面浏览和搜索代码片段：左侧按语言筛选，顶部按难度筛选，点击代码卡片查看完整代码（语法高亮）。AI搜索支持自然语言查找代码。RAG知识库可上传编程文档进行智能问答。', 0, '说明']
    );
    console.log('✅ 已插入知识库示例数据');
  }

  console.log('✅ 数据库初始化完成');
}

// ==================== 优雅关闭 ====================
process.on('SIGINT', async () => {
  console.log('\n🛑 正在关闭服务器...');
  if (pool) await pool.end();
  process.exit(0);
});

// ==================== 启动 ====================

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
====================================================
  🚀  GY·代码知识库 (Code Learning Hub) 已启动
  地址: http://localhost:${PORT}
  ── 代码片段管理 ──────────────────────
  GET    /api/code_snippets          - 查询代码（支持筛选/排序/分页）
  GET    /api/code_snippets/:id      - 获取单条代码
  POST   /api/code_snippets          - 新增代码片段
  PUT    /api/code_snippets/:id      - 更新代码
  DELETE /api/code_snippets/:id      - 删除代码

  ── 辅助数据 ──────────────────────────────
  GET    /api/languages              - 编程语言列表

  ── 🤖 AI 代码搜索 ─────────────────────
  POST  /api/ai/search              - 自然语言搜代码

  ── 📚 RAG 知识库问答 ─────────────────
  POST  /api/rag/documents          - 上传文档到知识库
  GET   /api/rag/documents          - 查看知识库文档列表
  POST  /api/rag/ask                - 基于知识库问答

  ── 示例查询 ─────────────────────────────
  curl http://localhost:${PORT}/api/code_snippets
  curl "http://localhost:${PORT}/api/code_snippets?language=Python&difficulty=beginner"
  curl -X POST http://localhost:${PORT}/api/ai/search \\
    -H "Content-Type: application/json" \\
    -d '{"query":"找排序算法的代码"}'

  ── 查询参数 ───────────────────────────
  ?col=val              - 列筛选（数字 =，字符串 LIKE）
  ?minCol=N&maxCol=N    - 范围查询
  &_sort=col            - 排序列（默认主键）
  &_order=DESC          - 排序方向
  &_page=1&_size=20     - 分页
====================================================
      `);
    });
  })
  .catch((err) => {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
  });
