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
    const systemPrompt = `你是一个 MySQL 数据库查询助手。数据库包含以下表：

${schemaContext}

请根据用户的问题生成 SQL 查询语句。
要求：
- 只生成 SELECT 查询，不要修改数据
- 列名用反引号包裹，表名用反引号包裹
- 字符串用单引号
- 如果问题指定了表名，只查那张表
- 如果问题模棱两可，选最合理的表
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

// ==================== 建表示例 & 启动 ====================

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

  // ----- 创建示例表 -----

  // users 表
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id         INT             NOT NULL AUTO_INCREMENT,
      name       VARCHAR(100)    NOT NULL,
      email      VARCHAR(200)    NOT NULL UNIQUE,
      age        INT             NULL,
      created_at DATETIME        DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [userCount] = await pool.execute('SELECT COUNT(*) AS count FROM users');
  if (userCount[0].count === 0) {
    await pool.execute(
      'INSERT INTO users (name, email, age) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)',
      ['张三', 'zhangsan@example.com', 28,
       '李四', 'lisi@example.com', 35,
       '王五', 'wangwu@example.com', 22,
       '赵六', 'zhaoliu@example.com', 30]
    );
    console.log('✅ 已插入 users 示例数据');
  }

  // categories 表
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id          INT          NOT NULL AUTO_INCREMENT,
      name        VARCHAR(100) NOT NULL,
      description TEXT         NULL,
      sort_order  INT          DEFAULT 0,
      created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [catCount] = await pool.execute('SELECT COUNT(*) AS count FROM categories');
  if (catCount[0].count === 0) {
    await pool.execute(
      'INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
      ['电子产品', '手机、电脑、平板等数码产品', 1,
       '服装鞋帽', '服饰、鞋类及配饰', 2,
       '图书音像', '书籍、音乐、影视', 3]
    );
    console.log('✅ 已插入 categories 示例数据');
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
  🚀  GY·通用 CRUD API (MySQL) 已启动
  地址: http://localhost:${PORT}
  ── 元数据 ──────────────────────────────
  GET  /api/tables              - 查看所有表
  GET  /api/tables/:table/schema - 查看表结构
  POST /api/tables             - 创建新表

  ── 通用行数据操作 ──────────────────────
  GET    /api/:table           - 查询行（支持筛选/排序/分页）
  GET    /api/:table/:id       - 获取单行（按主键）
  POST   /api/:table           - 插入行
  PUT    /api/:table/:id       - 更新行（按主键）
  PATCH  /api/:table/:id       - 部分更新行（按主键）
  DELETE /api/:table/:id       - 删除行（按主键）

  ── 示例 ───────────────────────────────
  curl http://localhost:${PORT}/api/users
  curl http://localhost:${PORT}/api/categories
  curl "http://localhost:${PORT}/api/users?name=张三&minAge=20"

  ── 查询参数 ───────────────────────────
  ?col=val         - 列筛选（数字 =，字符串 LIKE）
  ?minCol=N&maxCol=N - 范围查询
  &_sort=col       - 排序列（默认主键）
  &_order=DESC     - 排序方向
  &_page=1&_size=50 - 分页
====================================================
      `);
    });
  })
  .catch((err) => {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
  });
