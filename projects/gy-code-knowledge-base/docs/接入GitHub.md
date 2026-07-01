# 接入 GitHub — 三步推送

在项目目录下依次执行：

## 1. 创建 GitHub 仓库（用你的 token）

```bash
curl -s -X POST https://api.github.com/user/repos \
  -H "Authorization: token 你的GitHubToken" \
  -H "Content-Type: application/json" \
  -d '{"name":"gy-code-knowledge-base","private":false}'
```

看到返回 `"full_name": "PETN-Misty/gy-code-knowledge-base"` 就成功了。

## 2. 关联远程仓库并推送

```bash
cd "C:\Users\li\Desktop\26-6\demo2"
git remote add origin https://github.com/PETN-Misty/gy-code-knowledge-base.git
git push -u origin master
```

## 3. 验证

打开浏览器访问：
```
https://github.com/PETN-Misty/gy-code-knowledge-base
```
