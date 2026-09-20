const fs = require('fs');
const path = require('path');
const ClusterManager = require('./clusterManager');
const { assertSafeToken } = require('./utils/validateInput');

class MultiClusterLogManager {
  constructor(clusterTag) {
    this.clusterManager = new ClusterManager();
    this.clusterTag = clusterTag;
    this.logsDir = this.clusterManager.getClusterLogsDir(clusterTag);
    this.currentDir = this.clusterManager.getClusterCurrentDir(clusterTag);
    this.metadataDir = this.clusterManager.getClusterMetadataDir(clusterTag);
    
    // 确保目录存在
    this.ensureDirs();
  }

  ensureDirs() {
    [this.logsDir, this.currentDir, this.metadataDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  // 创建新的日志文件
  createLogFile(step) {
    assertSafeToken(step, 'step', { maxLength: 64 });
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const logFileName = `${timestamp}_${step}.log`;
    const logFilePath = path.join(this.logsDir, logFileName);
    
    // 创建空日志文件
    fs.writeFileSync(logFilePath, '');
    
    // 创建或更新软链接
    const currentLinkPath = path.join(this.currentDir, `${step}.log`);
    
    // 删除旧的软链接（如果存在）
    if (fs.existsSync(currentLinkPath)) {
      fs.unlinkSync(currentLinkPath);
    }
    
    // 创建新的软链接
    const relativePath = path.relative(this.currentDir, logFilePath);
    fs.symlinkSync(relativePath, currentLinkPath);
    
    console.log(`Created log file for cluster ${this.clusterTag}: ${logFileName}`);
    return logFilePath;
  }

  // 读取日志内容（支持增量读取）
  //
  // step 会直接拼进文件路径。路由入口已经校验，这里再断言一次是刻意的：
  // 与 S4 的处理方式一致——路径构造点自己也要拒绝非法名字，否则下一个调用方
  // （例如某个后台任务）绕过路由时又是一个遍历入口。
  readLogContent(step, offset = 0) {
    assertSafeToken(step, 'step', { maxLength: 64 });
    const currentLinkPath = path.join(this.currentDir, `${step}.log`);
    
    if (!fs.existsSync(currentLinkPath)) {
      return { content: '', offset: 0, exists: false };
    }

    try {
      const stats = fs.statSync(currentLinkPath);
      const fileSize = stats.size;
      
      if (offset >= fileSize) {
        return { content: '', offset: fileSize, exists: true };
      }

      const fd = fs.openSync(currentLinkPath, 'r');
      const bufferSize = fileSize - offset;
      const buffer = Buffer.alloc(bufferSize);
      
      fs.readSync(fd, buffer, 0, bufferSize, offset);
      fs.closeSync(fd);
      
      const content = buffer.toString('utf8');
      
      return {
        content,
        offset: fileSize,
        exists: true
      };
    } catch (error) {
      console.error(`Error reading log for ${step}:`, error.message);
      return { content: '', offset: 0, exists: false };
    }
  }

  // 获取历史日志文件列表
  getLogHistory() {
    try {
      if (!fs.existsSync(this.logsDir)) {
        return [];
      }

      const files = fs.readdirSync(this.logsDir);
      const logFiles = files
        .filter(file => file.endsWith('.log'))
        .map(file => {
          const filePath = path.join(this.logsDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
          };
        })
        .sort((a, b) => b.created - a.created);

      return logFiles;
    } catch (error) {
      console.error('Error getting log history:', error.message);
      return [];
    }
  }

  // 清理旧日志文件（保留最近N个）
  cleanupOldLogs(keepCount = 10) {
    try {
      const logFiles = this.getLogHistory();
      
      if (logFiles.length <= keepCount) {
        return;
      }

      const filesToDelete = logFiles.slice(keepCount);
      
      filesToDelete.forEach(file => {
        try {
          fs.unlinkSync(file.path);
          console.log(`Deleted old log file: ${file.name}`);
        } catch (error) {
          console.warn(`Failed to delete log file ${file.name}:`, error.message);
        }
      });
    } catch (error) {
      console.error('Error cleaning up logs:', error.message);
    }
  }
}

module.exports = MultiClusterLogManager;
