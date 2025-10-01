const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

class EmailQueueManager extends EventEmitter {
  constructor() {
    super();
    this.updateQueue = new Map();
    this.globalExplorationQueue = new Map();
    this.domainLocks = new Map();
    this.saveInterval = null;
    this.queueCleanupInterval = null;
    this.isProcessing = false;
    this.SAVE_INTERVAL_MS = 30000;
    this.QUEUE_CLEANUP_INTERVAL_MS = 120000;
    this.bufferFilePath = null;
    this.globalQueueFilePath = null;
    this.initialized = false;
    this.MAX_CONCURRENT_DOMAIN_EXPLORERS = 1;
    this.pendingRequests = new Map();
    this.domainCallbacks = new Map();
    this.isSavingGlobalQueue = false;
    this.pendingGlobalSave = false;
  }

  async requestExplorationSlot(domain, requesterId = null, callback = null) {
    await this.init();
    
    const reqId = requesterId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const queueInfo = this.globalExplorationQueue.get(domain) || {
      activeExploreCount: 0,
      lastStartTime: 0,
      lastEndTime: 0,
      explorerIds: new Set(),
      firstRequestTime: Date.now()
    };
    
    const now = Date.now();
    
    if (queueInfo.activeExploreCount >= this.MAX_CONCURRENT_DOMAIN_EXPLORERS) {
      config.smartLog('queue', `Domain ${domain} at max email exploration capacity: ${queueInfo.activeExploreCount} explorers - User ${reqId} added to buffer`);
      
      const waitingRequests = this.pendingRequests.get(domain) || [];
      const request = {
        requesterId: reqId,
        timestamp: Date.now(),
        callback: callback
      };
      waitingRequests.push(request);
      this.pendingRequests.set(domain, waitingRequests);
      
      if (callback) {
        const callbacks = this.domainCallbacks.get(domain) || [];
        callbacks.push({ requesterId: reqId, callback });
        this.domainCallbacks.set(domain, callbacks);
        config.smartLog('queue', `Email callback registered for ${domain}: ${reqId}`);
      }
      
      return {
        allowed: false,
        reason: 'buffered',
        activeExploreCount: queueInfo.activeExploreCount,
        queuePosition: waitingRequests.length,
        requesterId: reqId,
        message: 'Added to intelligent email buffer - will receive results when exploration completes'
      };
    }
    
    const explorerId = `${domain}_${now}_${reqId}`;
    queueInfo.activeExploreCount++;
    queueInfo.lastStartTime = now;
    queueInfo.explorerIds.add(explorerId);
    
    this.globalExplorationQueue.set(domain, queueInfo);
    this.domainLocks.set(domain, { timestamp: now, explorerId });
    
    await this.saveGlobalQueueFile();
    
    config.smartLog('queue', `Email exploration slot granted for ${domain}: explorer=${explorerId}, active=${queueInfo.activeExploreCount}`);
    
    return {
      allowed: true,
      explorerId,
      domain,
      activeExploreCount: queueInfo.activeExploreCount,
      estimatedDuration: 60000
    };
  }

  async saveBufferFile() {
    if (!this.bufferFilePath) return;
    
    const bufferData = {
      updates: Object.fromEntries(this.updateQueue),
      lastSaved: new Date().toISOString(),
      version: '1.0',
      queueSize: this.updateQueue.size
    };
    
    try {
      const dir = path.dirname(this.bufferFilePath);
      await fs.mkdir(dir, { recursive: true });
      
      const tempPath = path.join(dir, `email-queue-buffer.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}.json`);
      await fs.writeFile(tempPath, JSON.stringify(bufferData, null, 2), { encoding: 'utf8' });
      
      try {
        const tempStats = await fs.stat(tempPath);
        if (tempStats.size < 10) {
          await fs.unlink(tempPath);
          throw new Error('Email buffer temp file too small');
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') {
          await fs.unlink(tempPath).catch(() => {});
          throw new Error(`Email buffer temp file validation failed: ${statError.message}`);
        }
      }
      
      try {
        await fs.access(this.bufferFilePath);
        await fs.unlink(this.bufferFilePath);
      } catch (error) {
      }
      
      await fs.rename(tempPath, this.bufferFilePath);
      config.smartLog('queue', `Saved ${this.updateQueue.size} email updates to buffer file`);
    } catch (error) {
      config.smartLog('fail', `Failed to save email buffer file: ${error.message}`, { stackTrace: error.stack });
      
      const dir = path.dirname(this.bufferFilePath);
      try {
        const tempFiles = await fs.readdir(dir);
        for (const file of tempFiles) {
          if (file.startsWith('email-queue-buffer.tmp.')) {
            await fs.unlink(path.join(dir, file)).catch(() => {});
          }
        }
      } catch (cleanupError) {
      }
    }
  }

  async saveGlobalQueueFile() {
    if (!this.globalQueueFilePath) return;
    
    if (this.isSavingGlobalQueue) {
      this.pendingGlobalSave = true;
      return;
    }
    
    this.isSavingGlobalQueue = true;
    
    try {
      const dir = path.dirname(this.globalQueueFilePath);
      await fs.mkdir(dir, { recursive: true });
      
      const globalQueueData = {};
      for (const [domain, info] of this.globalExplorationQueue.entries()) {
        globalQueueData[domain] = {
          ...info,
          explorerIds: Array.from(info.explorerIds || [])
        };
      }
      
      const queueData = {
        globalEmailQueue: globalQueueData,
        lastSaved: new Date().toISOString(),
        version: '1.0',
        queueSize: this.globalExplorationQueue.size
      };
      
      const tempPath = path.join(dir, `global-email-queue.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}.json`);
      await fs.writeFile(tempPath, JSON.stringify(queueData, null, 2), { encoding: 'utf8' });
      
      try {
        const tempStats = await fs.stat(tempPath);
        if (tempStats.size < 10) {
          await fs.unlink(tempPath);
          throw new Error('Global email queue temp file too small');
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') {
          await fs.unlink(tempPath).catch(() => {});
          throw new Error(`Global email queue temp file validation failed: ${statError.message}`);
        }
      }
      
      try {
        await fs.access(this.globalQueueFilePath);
        await fs.unlink(this.globalQueueFilePath);
      } catch (error) {
      }
      
      await fs.rename(tempPath, this.globalQueueFilePath);
      config.smartLog('queue', `Saved ${this.globalExplorationQueue.size} email domains to global queue file`);
      
    } catch (error) {
      config.smartLog('fail', `Failed to save global email queue file: ${error.message}`, { stackTrace: error.stack });
      
      const dir = path.dirname(this.globalQueueFilePath);
      try {
        const tempFiles = await fs.readdir(dir);
        for (const file of tempFiles) {
          if (file.startsWith('global-email-queue.tmp.')) {
            await fs.unlink(path.join(dir, file)).catch(() => {});
          }
        }
      } catch (cleanupError) {
      }
    } finally {
      this.isSavingGlobalQueue = false;
      
      if (this.pendingGlobalSave) {
        this.pendingGlobalSave = false;
        setTimeout(() => this.saveGlobalQueueFile(), 100);
      }
    }
  }

  notifyWaitingRequests(domain, cacheData) {
    const callbacks = this.domainCallbacks.get(domain);
    if (!callbacks || callbacks.length === 0) {
      config.smartLog('queue', `No email callbacks to notify for ${domain}`);
      return;
    }
    
    config.smartLog('queue', `Notifying ${callbacks.length} waiting email requests for ${domain} with fresh cache data`);
    
    const notifiedCallbacks = [];
    
    for (const { requesterId, callback } of callbacks) {
      if (callback && typeof callback === 'function') {
        try {
          callback({
            success: true,
            source: 'cache-notification',
            data: cacheData,
            requesterId,
            notifiedAt: Date.now()
          });
          config.smartLog('queue', `Notified email request ${requesterId} for ${domain}`);
          notifiedCallbacks.push(requesterId);
        } catch (error) {
          config.smartLog('fail', `Error notifying email request ${requesterId}: ${error.message}`, { stackTrace: error.stack });
        }
      }
    }
    
    this.domainCallbacks.delete(domain);
    this.pendingRequests.delete(domain);
    config.smartLog('queue', `Cleaned up pending email requests for ${domain} (notified: ${notifiedCallbacks.length})`);
  }
  
  async releaseExplorationSlot(domain, explorerId, cacheData = null) {
    await this.init();
    
    const queueInfo = this.globalExplorationQueue.get(domain);
    if (!queueInfo) {
      config.smartLog('alert', `No email queue info found for domain ${domain} when releasing explorer ${explorerId}`);
      return;
    }
    
    queueInfo.activeExploreCount = Math.max(0, queueInfo.activeExploreCount - 1);
    queueInfo.explorerIds.delete(explorerId);
    queueInfo.lastEndTime = Date.now();
    
    if (cacheData) {
      config.smartLog('queue', `Releasing email slot for ${domain} with cache data - triggering notifications`);
      this.notifyWaitingRequests(domain, cacheData);
    } else {
      config.smartLog('queue', `Releasing email slot for ${domain} without cache data`);
      const callbacks = this.domainCallbacks.get(domain);
      if (callbacks && callbacks.length > 0) {
        config.smartLog('alert', `Notifying ${callbacks.length} waiting email requests about exploration failure`);
        for (const { requesterId, callback } of callbacks) {
          if (callback && typeof callback === 'function') {
            try {
              callback({
                success: false,
                error: 'Email exploration failed',
                source: 'exploration-failure',
                requesterId,
                notifiedAt: Date.now()
              });
            } catch (error) {
              config.smartLog('fail', `Error notifying email failure to ${requesterId}: ${error.message}`, { stackTrace: error.stack });
            }
          }
        }
        this.domainCallbacks.delete(domain);
        this.pendingRequests.delete(domain);
      }
    }
    
    if (queueInfo.activeExploreCount === 0) {
      this.domainLocks.delete(domain);
      config.smartLog('queue', `All email explorers released for ${domain}`);
    }
    
    this.globalExplorationQueue.set(domain, queueInfo);
    await this.saveGlobalQueueFile();
    
    config.smartLog('queue', `Email exploration slot released for ${domain}: explorer=${explorerId}, remaining=${queueInfo.activeExploreCount}`);
  }

  async init() {
    if (this.initialized) return;
    
    const profilesDir = path.join(__dirname, '../profiles');
    try {
      await fs.access(profilesDir);
    } catch (error) {
      await fs.mkdir(profilesDir, { recursive: true });
    }
    
    this.bufferFilePath = path.join(profilesDir, 'email-queue-buffer.json');
    this.globalQueueFilePath = path.join(profilesDir, 'global-email-queue.json');
    
    await this.loadBufferFile();
    await this.loadGlobalQueueFile();
    this.initialized = true;
    config.smartLog('service', 'EmailQueueManager initialized');
  }

  async loadBufferFile() {
    try {
      const data = await fs.readFile(this.bufferFilePath, 'utf-8');
      const bufferData = JSON.parse(data);
      
      if (bufferData.updates && typeof bufferData.updates === 'object') {
        this.updateQueue = new Map(Object.entries(bufferData.updates));
        config.smartLog('service', `Loaded ${this.updateQueue.size} pending email updates from buffer file`);
      }
      
      await this.clearBufferFile();
    } catch (error) {
      if (error.code === 'ENOENT') {
        config.smartLog('service', `Email buffer file not found, creating: ${this.bufferFilePath}`);
        await this.createEmptyBufferFile();
      } else if (error.name === 'SyntaxError') {
        config.smartLog('fail', 'Corrupted email buffer file detected, creating backup and new file', { stackTrace: error.stack });
        const backupPath = `${this.bufferFilePath}.corrupted.${Date.now()}`;
        try {
          await fs.copyFile(this.bufferFilePath, backupPath);
          config.smartLog('service', `Email buffer backup saved to: ${backupPath}`);
        } catch (backupError) {
          config.smartLog('fail', `Failed to create email buffer backup: ${backupError.message}`, { stackTrace: backupError.stack });
        }
        await this.createEmptyBufferFile();
      }
    }
  }

  async loadGlobalQueueFile() {
    try {
      const data = await fs.readFile(this.globalQueueFilePath, 'utf-8');
      const queueData = JSON.parse(data);
      
      if (queueData.globalEmailQueue && typeof queueData.globalEmailQueue === 'object') {
        for (const [domain, info] of Object.entries(queueData.globalEmailQueue)) {
          this.globalExplorationQueue.set(domain, {
            ...info,
            explorerIds: new Set(info.explorerIds || [])
          });
        }
        config.smartLog('service', `Loaded ${this.globalExplorationQueue.size} email domains from global queue file`);
      }
      
      await this.clearGlobalQueueFile();
    } catch (error) {
      if (error.code === 'ENOENT') {
        config.smartLog('service', `Global email queue file not found, creating: ${this.globalQueueFilePath}`);
        await this.createEmptyGlobalQueueFile();
      } else if (error.name === 'SyntaxError') {
        config.smartLog('fail', 'Corrupted global email queue file detected, creating backup and new file', { stackTrace: error.stack });
        const backupPath = `${this.globalQueueFilePath}.corrupted.${Date.now()}`;
        try {
          await fs.copyFile(this.globalQueueFilePath, backupPath);
          config.smartLog('service', `Global email queue backup saved to: ${backupPath}`);
        } catch (backupError) {
          config.smartLog('fail', `Failed to create global email queue backup: ${backupError.message}`, { stackTrace: backupError.stack });
        }
        await this.createEmptyGlobalQueueFile();
      }
    }
  }

  async createEmptyBufferFile() {
    const emptyBuffer = {
      updates: {},
      lastSaved: new Date().toISOString(),
      version: '1.0'
    };
    
    try {
      const dir = path.dirname(this.bufferFilePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.bufferFilePath, JSON.stringify(emptyBuffer, null, 2), { encoding: 'utf8' });
      config.smartLog('service', `Created empty email buffer file: ${this.bufferFilePath}`);
    } catch (error) {
      config.smartLog('fail', `Failed to create email buffer file: ${error.message}`, { stackTrace: error.stack });
    }
  }

  async createEmptyGlobalQueueFile() {
    const emptyQueue = {
      globalEmailQueue: {},
      lastSaved: new Date().toISOString(),
      version: '1.0'
    };
    
    try {
      const dir = path.dirname(this.globalQueueFilePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.globalQueueFilePath, JSON.stringify(emptyQueue, null, 2), { encoding: 'utf8' });
      config.smartLog('service', `Created empty global email queue file: ${this.globalQueueFilePath}`);
    } catch (error) {
      config.smartLog('fail', `Failed to create global email queue file: ${error.message}`, { stackTrace: error.stack });
    }
  }

  async clearBufferFile() {
    try {
      await this.createEmptyBufferFile();
    } catch (error) {
      config.smartLog('fail', `Failed to clear email buffer file: ${error.message}`, { stackTrace: error.stack });
    }
  }

  async clearGlobalQueueFile() {
    try {
      await this.createEmptyGlobalQueueFile();
    } catch (error) {
      config.smartLog('fail', `Failed to clear global email queue file: ${error.message}`, { stackTrace: error.stack });
    }
  }

  async start() {
    await this.init();
    
    if (this.saveInterval) return;
    
    this.saveInterval = setInterval(async () => {
      await this.processPendingUpdates();
    }, this.SAVE_INTERVAL_MS);
    
    this.queueCleanupInterval = setInterval(async () => {
      await this.cleanupExpiredGlobalQueue();
    }, this.QUEUE_CLEANUP_INTERVAL_MS);
    
    config.smartLog('service', 'EmailQueueManager started - saves every 30 seconds, queue cleanup every 2 minutes');
    
    if (this.updateQueue.size > 0) {
      config.smartLog('queue', `Processing ${this.updateQueue.size} pending email updates from buffer`);
      setTimeout(() => this.processPendingUpdates(), 1000);
    }
  }

  async queueProfileUpdate(domain, profileData) {
    await this.init();
    
    if (!profileData || typeof profileData !== 'object') {
      config.smartLog('alert', `Invalid email profile data for ${domain}, skipping queue`);
      return;
    }
    
    this.updateQueue.set(domain, {
      ...profileData,
      queuedAt: Date.now()
    });
    
    config.smartLog('queue', `Email profile update queued for ${domain} (queue size: ${this.updateQueue.size})`);
    
    await this.saveBufferFile();
  }

  async processPendingUpdates() {
    if (this.isProcessing || this.updateQueue.size === 0) return;
    
    this.isProcessing = true;
    config.smartLog('queue', `Processing ${this.updateQueue.size} pending email profile updates...`);
    
    try {
      const DomainProfiler = require('./DomainProfiler');
      const profiler = new DomainProfiler();
      
      let processedCount = 0;
      let errorCount = 0;
      
      for (const [domain, update] of this.updateQueue.entries()) {
        try {
          const success = await profiler.applyQueuedUpdate(domain, update);
          if (success) {
            processedCount++;
          } else {
            errorCount++;
            config.smartLog('alert', `Failed to apply email update for ${domain}`);
          }
        } catch (error) {
          errorCount++;
          config.smartLog('fail', `Error applying email update for ${domain}: ${error.message}`, { stackTrace: error.stack });
        }
      }
      
      if (processedCount > 0) {
        await profiler.saveCurrentProfiles();
        config.smartLog('queue', `Successfully processed ${processedCount} email profile updates`);
      }
      
      if (errorCount > 0) {
        config.smartLog('alert', `${errorCount} email updates failed to process`);
      }
      
      this.updateQueue.clear();
      await this.clearBufferFile();
      
    } catch (error) {
      config.smartLog('fail', `Error processing email profile updates: ${error.message}`, { stackTrace: error.stack });
    } finally {
      this.isProcessing = false;
    }
  }

  async cleanupExpiredGlobalQueue() {
    const now = Date.now();
    const expiredThresholdMs = 2 * 60 * 60 * 1000;
    let cleanedCount = 0;
    
    for (const [domain, queueInfo] of this.globalExplorationQueue.entries()) {
      const timeSinceLastActivity = now - queueInfo.lastStartTime;
      
      if (timeSinceLastActivity > expiredThresholdMs && queueInfo.activeExploreCount === 0) {
        this.globalExplorationQueue.delete(domain);
        this.domainLocks.delete(domain);
        
        const waitingRequests = this.pendingRequests.get(domain);
        const callbacks = this.domainCallbacks.get(domain);
        
        if (callbacks && callbacks.length > 0) {
          config.smartLog('queue', `Notifying ${callbacks.length} expired email callbacks for ${domain}`);
          for (const { requesterId, callback } of callbacks) {
            if (callback && typeof callback === 'function') {
              try {
                callback({
                  success: false,
                  error: 'Email domain queue expired',
                  source: 'timeout',
                  requesterId,
                  notifiedAt: Date.now()
                });
              } catch (error) {
                config.smartLog('fail', `Error notifying expired email callback ${requesterId}: ${error.message}`, { stackTrace: error.stack });
              }
            }
          }
          this.domainCallbacks.delete(domain);
        }
        
        this.pendingRequests.delete(domain);
        
        cleanedCount++;
        config.smartLog('queue', `Cleaned expired email queue entry for ${domain}`);
      }
    }
    
    for (const [domain, lockInfo] of this.domainLocks.entries()) {
      const timeSinceLock = now - lockInfo.timestamp;
      const lockExpiredMs = 15 * 60 * 1000;
      
      if (timeSinceLock > lockExpiredMs) {
        this.domainLocks.delete(domain);
        config.smartLog('queue', `Released expired email lock for ${domain}`);
      }
    }
    
    if (cleanedCount > 0) {
      await this.saveGlobalQueueFile();
      config.smartLog('queue', `Cleaned up ${cleanedCount} expired email queue entries`);
    }
    
    return cleanedCount;
  }

  async stop() {
    config.smartLog('service', 'EmailQueueManager stopping...');
    
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    
    if (this.queueCleanupInterval) {
      clearInterval(this.queueCleanupInterval);
      this.queueCleanupInterval = null;
    }
    
    if (this.updateQueue.size > 0) {
      config.smartLog('queue', `Saving ${this.updateQueue.size} pending email updates to buffer before shutdown`);
      await this.saveBufferFile();
    }
    
    if (this.globalExplorationQueue.size > 0) {
      config.smartLog('queue', `Saving ${this.globalExplorationQueue.size} global email queue entries before shutdown`);
      await this.saveGlobalQueueFile();
    }
    
    for (const [domain, callbacks] of this.domainCallbacks.entries()) {
      config.smartLog('queue', `Notifying ${callbacks.length} email callbacks about shutdown for ${domain}`);
      for (const { requesterId, callback } of callbacks) {
        if (callback && typeof callback === 'function') {
          try {
            callback({
              success: false,
              error: 'Email system shutdown',
              source: 'shutdown',
              requesterId,
              notifiedAt: Date.now()
            });
          } catch (error) {
            config.smartLog('fail', `Error notifying email shutdown to ${requesterId}: ${error.message}`, { stackTrace: error.stack });
          }
        }
      }
    }
    
    this.pendingRequests.clear();
    this.domainCallbacks.clear();
    this.initialized = false;
    
    config.smartLog('service', 'EmailQueueManager stopped');
  }

  getQueueStats() {
    const globalQueueDetails = Array.from(this.globalExplorationQueue.entries()).map(([domain, info]) => ({
      domain,
      activeExploreCount: info.activeExploreCount,
      lastStartTime: new Date(info.lastStartTime).toISOString(),
      explorerIds: Array.from(info.explorerIds),
      waitingRequestsCount: (this.pendingRequests.get(domain) || []).length,
      callbacksCount: (this.domainCallbacks.get(domain) || []).length
    }));
    
    const totalWaitingRequests = Array.from(this.pendingRequests.values())
      .reduce((sum, requests) => sum + requests.length, 0);
    
    const totalCallbacks = Array.from(this.domainCallbacks.values())
      .reduce((sum, callbacks) => sum + callbacks.length, 0);
    
    return {
      emailUpdateQueueSize: this.updateQueue.size,
      globalExplorationQueueSize: this.globalExplorationQueue.size,
      totalActiveExploreCount: globalQueueDetails.reduce((sum, q) => sum + q.activeExploreCount, 0),
      totalWaitingRequests,
      totalCallbacks,
      domainLocksCount: this.domainLocks.size,
      isProcessing: this.isProcessing,
      saveIntervalMs: this.SAVE_INTERVAL_MS,
      bufferFilePath: this.bufferFilePath,
      globalQueueFilePath: this.globalQueueFilePath,
      initialized: this.initialized,
      globalQueueDetails,
      config: {
        maxConcurrentDomainExplorers: this.MAX_CONCURRENT_DOMAIN_EXPLORERS,
        queueCleanupIntervalMs: this.QUEUE_CLEANUP_INTERVAL_MS
      }
    };
  }

  async getDetailedStats() {
    const stats = this.getQueueStats();
    
    const domainStats = {};
    for (const [domain, queueInfo] of this.globalExplorationQueue.entries()) {
      domainStats[domain] = {
        activeExploreCount: queueInfo.activeExploreCount,
        lastStartTime: new Date(queueInfo.lastStartTime).toISOString(),
        explorerIds: Array.from(queueInfo.explorerIds),
        waitingRequests: (this.pendingRequests.get(domain) || []).length,
        activeCallbacks: (this.domainCallbacks.get(domain) || []).length,
        isLocked: this.domainLocks.has(domain),
        timeSinceLastActivity: Date.now() - queueInfo.lastStartTime
      };
    }
    
    return {
      ...stats,
      domainStats,
      systemHealth: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }
    };
  }

  async clearQueue() {
    const clearedEmailCount = this.updateQueue.size;
    const clearedGlobalCount = this.globalExplorationQueue.size;
    const clearedWaitingCount = Array.from(this.pendingRequests.values())
      .reduce((sum, requests) => sum + requests.length, 0);
    const clearedCallbacksCount = Array.from(this.domainCallbacks.values())
      .reduce((sum, callbacks) => sum + callbacks.length, 0);
    
    this.updateQueue.clear();
    this.globalExplorationQueue.clear();
    this.domainLocks.clear();
    
    for (const [domain, callbacks] of this.domainCallbacks.entries()) {
      for (const { requesterId, callback } of callbacks) {
        if (callback && typeof callback === 'function') {
          try {
            callback({
              success: false,
              error: 'Email queue cleared',
              source: 'manual-clear',
              requesterId,
              notifiedAt: Date.now()
            });
          } catch (error) {
            config.smartLog('fail', `Error notifying cleared email callback ${requesterId}: ${error.message}`, { stackTrace: error.stack });
          }
        }
      }
    }
    
    this.pendingRequests.clear();
    this.domainCallbacks.clear();
    
    await this.clearBufferFile();
    await this.clearGlobalQueueFile();
    
    config.smartLog('queue', `Cleared ${clearedEmailCount} email updates, ${clearedGlobalCount} global email queue entries, ${clearedWaitingCount} waiting requests, ${clearedCallbacksCount} callbacks`);
    
    return { 
      emailUpdates: clearedEmailCount, 
      globalQueue: clearedGlobalCount, 
      waitingRequests: clearedWaitingCount,
      callbacks: clearedCallbacksCount
    };
  }
}

module.exports = new EmailQueueManager();