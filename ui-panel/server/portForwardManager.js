const { spawn } = require('./utils/exec');

class PortForwardManager {
  constructor() {
    this.activeProcesses = new Map();
  }

  async startTemporary(serviceName, namespace = 'default', servicePort = 8000, localPort = 2020) {
    const requestId = `${serviceName}-${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      try {
        const process = spawn('kubectl', [
          'port-forward',
          `-n`, namespace,
          `service/${serviceName}`,
          `${localPort}:${servicePort}`
        ]);

        let isReady = false;

        process.stdout.on('data', (data) => {
          const output = data.toString();
          console.log(`[Port-Forward ${requestId}] ${output.trim()}`);
          
          if (output.includes('Forwarding from') && !isReady) {
            isReady = true;
            
            this.activeProcesses.set(requestId, {
              process,
              port: localPort,
              serviceName,
              startTime: Date.now()
            });
            
            resolve({
              success: true,
              requestId,
              localPort
            });
          }
        });

        process.stderr.on('data', (data) => {
          console.error(`[Port-Forward ${requestId} Error] ${data.toString()}`);
        });

        process.on('exit', (code) => {
          console.log(`[Port-Forward ${requestId}] Exited with code ${code}`);
          this.activeProcesses.delete(requestId);
        });

        setTimeout(() => {
          if (!isReady) {
            process.kill();
            reject(new Error('Port-forward startup timeout'));
          }
        }, 5000);

      } catch (error) {
        reject(error);
      }
    });
  }

  stop(requestId) {
    const pf = this.activeProcesses.get(requestId);
    if (pf) {
      console.log(`[Port-Forward] Stopping ${requestId}`);
      pf.process.kill();
      this.activeProcesses.delete(requestId);
      return true;
    }
    return false;
  }

  getActiveCount() {
    return this.activeProcesses.size;
  }
}

module.exports = new PortForwardManager();
