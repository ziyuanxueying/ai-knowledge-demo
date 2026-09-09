# ===== 基础镜像 =====
FROM node:20-alpine

# 设置时区为上海
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 设置工作目录
WORKDIR /app

# ===== 安装依赖 =====
# 先复制 package.json 文件，利用 Docker 缓存层
COPY package.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# 安装所有依赖（server + client）
RUN npm run install:all

# ===== 复制源码 =====
COPY . .

# ===== 构建前端 =====
RUN npm run build --prefix client

# ===== 暴露端口 =====
# Sealos 会通过环境变量 PORT 注入实际端口，这里只是声明
EXPOSE 3001

# ===== 启动后端（Express 同时托管前端静态文件） =====
CMD ["npm", "start"]
