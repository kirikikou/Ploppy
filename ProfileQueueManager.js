const EventEmitter = require('events');
const path = require('path');
const config = require('../config');
const fsSafe = require('../utils/fsSafe');

class ProfileQueueManager extends EventEmitter {
  constructor() {
    super();
    this.updateQueue = new Map();
    this.globalScrapingQueue = new Map();
    this.domainLocks = new Map();
    this.saveInterval = null;
    this.queueCleanupInterval = null;
    this.callbackCleanupInterval = null;
    this.isProcessing = false;
    this.SAVE_INTERVAL_MS = 30000;
    this.QUEUE_CLEANUP_INTERVAL_MS = 120000;
    this.CALLBACK_TTL_MS = 15 * 60 * 1000;
    this.bufferFilePath = null;
    this.globalQueueFilePath = null;
    this.initialized = false;
    this.MAX_CONCURRENT_DOMAIN_SCRAPERS = 1;
    this.pendingRequests = new Map();
    this.domainCallbacks = new Map();
    this.isSavingGlobalQueue = false;
    this.saveQueuePromises = [];
  }

  async requestScrapingSlot(domain, requesterId = null, callback = null) {
    await this.init();
    
    const reqId = requesterId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const queueInfo = this.globalScrapingQueue.get(domain) || {
      activeScrapeCount: 0,
      lastStartTime: 0,
      lastEndTime: 0,
      scraperIds: new Set(),
      firstRequestTime: Date.now()
    };
    
    const now = Date.now();
    
    if (queueInfo.activeScrapeCount >= this.MAX_CONCURRENT_DOMAIN_SCRAPERS) {
      config.smartLog('queue', `Domain ${domain} at max capacity: ${queueInfo.activeScrapeCount} scrapers - User ${reqId} added to buffer`);
      
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
        callbacks.push({ requesterId: reqId, callback, timestamp: Date.now() });
        this.domainCallbacks.set(domain, callbacks);
        config.smartLog('queue', `Callback registered for ${domain}: ${reqId}`);
      }
      
      return {
        allowed: false,
        reason: 'buffered',
        activeScrapeCount: queueInfo.activeScrapeCount,
        queuePosition: waitingRequests.length,
        requesterId: reqId,
        message: 'Added to intelligent buffer - will receive results when scraping completes'
      };
    }
    
    const scraperId = `${domain}_${now}_${reqId}`;
    queueInfo.activeScrapeCount++;
    queueInfo.lastStartTime = now;
    queueInfo.scraperIds.add(scraperId);
    
    this.globalScrapingQueue.set(domain, queueInfo);
    this.domainLocks.set(domain, { timestamp: now, scraperId });
    
    await this.saveGlobalQueueFile();
    
    config.smartLog('queue', `Scraping slot granted for ${domain}: scraper=${scraperId}, active=${queueInfo.activeScrapeCount}`);
    
    return {
      allowed: true,
      scraperId,
      domain,
      activeScrapeCount: queueInfo.activeScrapeCount,
      estimatedDuration: 30000
    };
  }

  async saveBufferFile() {
    if (!this.bufferFilePath) return;
    
    config.smartLog('buffer', `Saving profile queue → ${this.bufferFilePath}`);
    
    const bufferData = {
      updates: Object.fromEntries(this.updateQueue),
      lastSaved: new Date().toISOString(),
      version: '1.0',
      queueSize: this.updateQueue.size
    };
    
    try {
      const result = await fsSafe.writeJsonAtomic(this.bufferFilePath, bufferData);
      config.smartLog('queue', `Buffer saved: ${this.updateQueue.size} updates`);
      return result;
    } catch (error) {
      config.smartLog('fail', `Failed to save buffer file: ${error.message}`);
      throw error;
    }
  }

  async saveGlobalQueueFile() {
    if (!this.globalQueueFilePath) return;
    
    if (this.isSavingGlobalQueue) {
      return new Promise((resolve) => {
        this.saveQueuePromises.push(resolve);
      });
    }
    
    this.isSavingGlobalQueue = true;
    
    try {
      config.smartLog('buffer', `Saving global queue → ${this.globalQueueFilePath}`);
      
      const globalQueueData = {};
      for (const [domain, info] of this.globalScrapingQueue.entries()) {
        globalQueueData[domain] = {
          ...info,
          scraperIds: Array.from(info.scraperIds || [])
        };
      }
      
      const queueData = {
        globalQueue: globalQueueData,
        lastSaved: new Date().toISOString(),
        version: '1.0',
        queueSize: this.globalScrapingQueue.size
      };
      
      const result = await fsSafe.writeJsonAtomic(this.globalQueueFilePath, queueData);
      config.smartLog('queue', `Global queue saved: ${this.globalScrapingQueue.size} domains`);
      return result;
      
    } catch (error) {
      config.smartLog('fail', `Failed to save global queue file: ${error.message}`);
      throw error;
    } finally {
      this.isSavingGlobalQueue = false;
      
      if (this.saveQueuePromises.length > 0) {
        const promises = this.saveQueuePromises;
        this.saveQueuePromises = [];
        
        const result = await this.saveGlobalQueueFile();
        promises.forEach(resolve => resolve(result));
      }
    }
  }

  async cleanupExpiredCallbacks() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [domain, callbacks] of this.domainCallbacks.entries()) {
      const validCallbacks = callbacks.filter(cb => {
        const age = now - cb.timestamp;
        if (age > this.CALLBACK_TTL_MS) {
          if (cb.callback && typeof cb.callback === 'function') {
            try {
              cb.callback({
                success: false,
                error: 'Callback expired after 15 minutes',
                source: 'timeout',
                requesterId: cb.requesterId,
                notifiedAt: Date.now()
              });
            } catch (e) {
              config.smartLog('fail', `Error notifying expired callback: ${e.message}`);
            }
          }
          cleanedCount++;
          return false;
        }
        return true;
      });
      
      if (validCallbacks.length === 0) {
        this.domainCallbacks.delete(domain);
        this.pendingRequests.delete(domain);
      } else if (validCallbacks.length !== callbacks.length) {
        this.domainCallbacks.set(domain, validCallbacks);
      }
    }
    
    if (cleanedCount > 0) {
      config.smartLog('queue', `Cleaned ${cleanedCount} expired callbacks`);
    }
  }

  notifyWaitingRequests(domain, cacheData) {
    const callbacks = this.domainCallbacks.get(domain);
    if (!callbacks || callbacks.length === 0) {
      config.smartLog('queue', `No callbacks to notify for ${domain}`);
      return;
    }
    
    config.smartLog('queue', `Notifying ${callbacks.length} waiting requests for ${domain} with fresh cache data`);
    
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
          config.smartLog('queue', `Notified ${requesterId} for ${domain}`);
          notifiedCallbacks.push(requesterId);
        } catch (error) {
          config.smartLog('fail', `Error notifying request ${requesterId}: ${error.message}`);
        }
      }
    }
    
    this.domainCallbacks.delete(domain);
    this.pendingRequests.delete(domain);
    config.smartLog('queue', `Cleaned up pending requests for ${domain} (notified: ${notifiedCallbacks.length})`);
  }
  
  async releaseScrapingSlot(domain, scraperId, cacheData = null) {
    await this.init();
    
    const queueInfo = this.globalScrapingQueue.get(domain);
    if (!queueInfo) {
      config.smartLog('queue', `No queue info found for domain ${domain} when releasing scraper ${scraperId}`);
      return;
    }
    
    queueInfo.activeScrapeCount = Math.max(0, queueInfo.activeScrapeCount - 1);
    queueInfo.scraperIds.delete(scraperId);
    queueInfo.lastEndTime = Date.now();
    
    if (cacheData) {
      config.smartLog('queue', `Releasing slot for ${domain} with cache data - triggering notifications`);
      this.notifyWaitingRequests(domain, cacheData);
    } else {
      config.smartLog('queue', `Releasing slot for ${domain} without cache data`);
      const callbacks = this.domainCallbacks.get(domain);
      if (callbacks && callbacks.length > 0) {
        config.smartLog('queue', `Notifying ${callbacks.length} waiting requests about scraping failure`);
        for (const { requesterId, callback } of callbacks) {
          if (callback && typeof callback === 'function') {
            try {
              callback({
                success: false,
                error: 'Scraping failed',
                source: 'scraping-failure',
                requesterId,
                notifiedAt: Date.now()
              });
            } catch (error) {
              config.smartLog('fail', `Error notifying failure to ${requesterId}: ${error.message}`);
            }
          }
        }
        this.domainCallbacks.delete(domain);
        this.pendingRequests.delete(domain);
      }
    }
    
    if (queueInfo.activeScrapeCount === 0) {
      this.domainLocks.delete(domain);
      config.smartLog('queue', `All scrapers released for ${domain}`);
    }
    
    this.globalScrapingQueue.set(domain, queueInfo);
    await this.saveGlobalQueueFile();
    
    config.smartLog('queue', `Scraping slot released for ${domain}: scraper=${scraperId}, remaining=${queueInfo.activeScrapeCount}`);
  }

  async init() {
    if (this.initialized) return;
    
    const profilesDir = path.join(__dirname, '../profiles');
    await fsSafe.ensureDir(profilesDir);
    
    this.bufferFilePath = path.join(profilesDir, 'profile-queue-buffer.json');
    this.globalQueueFilePath = path.join(profilesDir, 'global-scraping-queue.json');
    
    await this.loadBufferFile();
    await this.loadGlobalQueueFile();
    await fsSafe.cleanupTempFiles(profilesDir);
    
    this.initialized = true;
    config.smartLog('queue', 'ProfileQueueManager initialized');
  }

  async loadBufferFile() {
    try {
      const bufferData = await fsSafe.readJsonSafe(this.bufferFilePath);
      
      if (bufferData && bufferData.updates && typeof bufferData.updates === 'object') {
        this.updateQueue = new Map(Object.entries(bufferData.updates));
        config.smartLog('queue', `Loaded ${this.updateQueue.size} pending updates from buffer file`);
      }
      
      await this.clearBufferFile();
    } catch (error) {
      config.smartLog('fail', `Failed to load buffer file: ${error.message}`);
      await this.createEmptyBufferFile();
    }
  }

  async loadGlobalQueueFile() {
    try {
      const queueData = await fsSafe.readJsonSafe(this.globalQueueFilePath);
      
      if (queueData && queueData.globalQueue && typeof queueData.globalQueue === 'object') {
        for (const [domain, info] of Object.entries(queueData.globalQueue)) {
          this.globalScrapingQueue.set(domain, {
            ...info,
            scraperIds: new Set(info.scraperIds || [])
          });
        }
        config.smartLog('queue', `Loaded ${this.globalScrapingQueue.size} domains from global queue file`);
      }
      
      await this.clearGlobalQueueFile();
    } catch (error) {
      config.smartLog('fail', `Failed to load global queue file: ${error.message}`);
      await this.createEmptyGlobalQueueFile();
    }
  }

  async createEmptyBufferFile() {
    const emptyBuffer = {
      updates: {},
      lastSaved: new Date().toISOString(),
      version: '1.0'
    };
    
    try {
      await fsSafe.writeJsonAtomic(this.bufferFilePath, emptyBuffer);
      config.smartLog('queue', `Created empty buffer file: ${this.bufferFilePath}`);
    } catch (error) {
      config.smartLog('fail', `Failed to create buffer file: ${error.message}`);
    }
  }

  async createEmptyGlobalQueueFile() {
    const emptyQueue = {
      globalQueue: {},
      lastSaved: new Date().toISOString(),
      version: '1.0'
    };
    
    try {
      await fsSafe.writeJsonAtomic(this.globalQueueFilePath, emptyQueue);
      config.smartLog('queue', `Created empty global queue file: ${this.globalQueueFilePath}`);
    } catch (error) {
      config.smartLog('fail', `Failed to create global queue file: ${error.message}`);
    }
  }

  async clearBufferFile() {
    try {
      await this.createEmptyBufferFile();
    } catch (error) {
      config.smartLog('fail', `Failed to clear buffer file: ${error.message}`);
    }
  }

  async clearGlobalQueueFile() {
    try {
      await this.createEmptyGlobalQueueFile();
    } catch (error) {
      config.smartLog('fail', `Failed to clear global queue file: ${error.message}`);
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
    
    this.callbackCleanupInterval = setInterval(async () => {
      await this.cleanupExpiredCallbacks();
    }, 5 * 60 * 1000);
    
    config.smartLog('queue', 'ProfileQueueManager started - saves every 30 seconds, queue cleanup every 2 minutes, callback cleanup every 5 minutes');
    
    if (this.updateQueue.size > 0) {
      config.smartLog('queue', `Processing ${this.updateQueue.size} pending updates from buffer`);
      setTimeout(() => this.processPendingUpdates(), 1000);
    }
  }

  async queueProfileUpdate(domain, profileData) {
    await this.init();
    
    if (!profileData || typeof profileData !== 'object') {
      config.smartLog('fail', `Invalid profile data for ${domain}, skipping queue`);
      return;
    }
    
    this.updateQueue.set(domain, {
      ...profileData,
      queuedAt: Date.now()
    });
    
    config.smartLog('queue', `Profile update queued for ${domain} (queue size: ${this.updateQueue.size})`);
    
    await this.saveBufferFile();
  }

  async processPendingUpdates() {
    if (this.isProcessing || this.updateQueue.size === 0) return;
    
    this.isProcessing = true;
    config.smartLog('queue', `Processing ${this.updateQueue.size} pending profile updates...`);
    
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
            config.smartLog('fail', `Failed to apply update for ${domain}`);
          }
        } catch (error) {
          errorCount++;
          config.smartLog('fail', `Error applying update for ${domain}: ${error.message}`);
        }
      }
      
      if (processedCount > 0) {
        await profiler.saveCurrentProfiles();
        config.smartLog('queue', `Successfully processed ${processedCount} profile updates`);
      }
      
      if (errorCount > 0) {
        config.smartLog('fail', `${errorCount} updates failed to process`);
      }
      
      this.updateQueue.clear();
      await this.clearBufferFile();
      
    } catch (error) {
      config.smartLog('fail', `Error processing profile updates: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async cleanupExpiredGlobalQueue() {
    const now = Date.now();
    const expiredThresholdMs = 2 * 60 * 60 * 1000;
    let cleanedCount = 0;
    
    for (const [domain, queueInfo] of this.globalScrapingQueue.entries()) {
      const timeSinceLastActivity = now - queueInfo.lastStartTime;
      
      if (timeSinceLastActivity > expiredThresholdMs && queueInfo.activeScrapeCount === 0) {
        this.globalScrapingQueue.delete(domain);
        this.domainLocks.delete(domain);
        
        const waitingRequests = this.pendingRequests.get(domain);
        const callbacks = this.domainCallbacks.get(domain);
        
        if (callbacks && callbacks.length > 0) {
          config.smartLog('queue', `Notifying ${callbacks.length} expired callbacks for ${domain}`);
          for (const { requesterId, callback } of callbacks) {
            if (callback && typeof callback === 'function') {
              try {
                callback({
                  success: false,
                  error: 'Domain queue expired',
                  source: 'timeout',
                  requesterId,
                  notifiedAt: Date.now()
                });
              } catch (error) {
                config.smartLog('fail', `Error notifying expired callback ${requesterId}: ${error.message}`);
              }
            }
          }
          this.domainCallbacks.delete(domain);
        }
        
        this.pendingRequests.delete(domain);
        
        cleanedCount++;
        config.smartLog('queue', `Cleaned expired queue entry for ${domain}`);
      }
    }
    
    for (const [domain, lockInfo] of this.domainLocks.entries()) {
      const timeSinceLock = now - lockInfo.timestamp;
      const lockExpiredMs = 15 * 60 * 1000;
      
      if (timeSinceLock > lockExpiredMs) {
        this.domainLocks.delete(domain);
        config.smartLog('queue', `Released expired lock for ${domain}`);
      }
    }
    
    if (cleanedCount > 0) {
      await this.saveGlobalQueueFile();
      config.smartLog('queue', `Cleaned up ${cleanedCount} expired queue entries`);
    }
    
    return cleanedCount;
  }

  async stop() {
    config.smartLog('queue', 'ProfileQueueManager stopping...');
    
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    
    if (this.queueCleanupInterval) {
      clearInterval(this.queueCleanupInterval);
      this.queueCleanupInterval = null;
    }
    
    if (this.callbackCleanupInterval) {
      clearInterval(this.callbackCleanupInterval);
      this.callbackCleanupInterval = null;
    }
    
    if (this.updateQueue.size > 0) {
      config.smartLog('queue', `Saving ${this.updateQueue.size} pending updates to buffer before shutdown`);
      await this.saveBufferFile();
    }
    
    if (this.globalScrapingQueue.size > 0) {
      config.smartLog('queue', `Saving ${this.globalScrapingQueue.size} global queue entries before shutdown`);
      await this.saveGlobalQueueFile();
    }
    
    for (const [domain, callbacks] of this.domainCallbacks.entries()) {
      config.smartLog('queue', `Notifying ${callbacks.length} callbacks about shutdown for ${domain}`);
      for (const { requesterId, callback } of callbacks) {
        if (callback && typeof callback === 'function') {
          try {
            callback({
              success: false,
              error: 'System shutdown',
              source: 'shutdown',
              requesterId,
              notifiedAt: Date.now()
            });
          } catch (error) {
            config.smartLog('fail', `Error notifying shutdown to ${requesterId}: ${error.message}`);
          }
        }
      }
    }
    
    this.pendingRequests.clear();
    this.domainCallbacks.clear();
    this.initialized = false;
    
    config.smartLog('queue', 'ProfileQueueManager stopped');
  }

  getQueueStats() {
    const globalQueueDetails = Array.from(this.globalScrapingQueue.entries()).map(([domain, info]) => ({
      domain,
      activeScrapeCount: info.activeScrapeCount,
      lastStartTime: new Date(info.lastStartTime).toISOString(),
      scraperIds: Array.from(info.scraperIds),
      waitingRequestsCount: (this.pendingRequests.get(domain) || []).length,
      callbacksCount: (this.domainCallbacks.get(domain) || []).length
    }));
    
    const totalWaitingRequests = Array.from(this.pendingRequests.values())
      .reduce((sum, requests) => sum + requests.length, 0);
    
    const totalCallbacks = Array.from(this.domainCallbacks.values())
      .reduce((sum, callbacks) => sum + callbacks.length, 0);
    
    return {
      profileUpdateQueueSize: this.updateQueue.size,
      globalScrapingQueueSize: this.globalScrapingQueue.size,
      totalActiveScrapeCount: globalQueueDetails.reduce((sum, q) => sum + q.activeScrapeCount, 0),
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
        maxConcurrentDomainScrapers: this.MAX_CONCURRENT_DOMAIN_SCRAPERS,
        queueCleanupIntervalMs: this.QUEUE_CLEANUP_INTERVAL_MS,
        callbackTTLMs: this.CALLBACK_TTL_MS
      }
    };
  }

  async getDetailedStats() {
    const stats = this.getQueueStats();
    
    const domainStats = {};
    for (const [domain, queueInfo] of this.globalScrapingQueue.entries()) {
      domainStats[domain] = {
        activeScrapeCount: queueInfo.activeScrapeCount,
        lastStartTime: new Date(queueInfo.lastStartTime).toISOString(),
        scraperIds: Array.from(queueInfo.scraperIds),
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
    const clearedProfileCount = this.updateQueue.size;
    const clearedGlobalCount = this.globalScrapingQueue.size;
    const clearedWaitingCount = Array.from(this.pendingRequests.values())
      .reduce((sum, requests) => sum + requests.length, 0);
    const clearedCallbacksCount = Array.from(this.domainCallbacks.values())
      .reduce((sum, callbacks) => sum + callbacks.length, 0);
    
    this.updateQueue.clear();
    this.globalScrapingQueue.clear();
    this.domainLocks.clear();
    
    for (const [domain, callbacks] of this.domainCallbacks.entries()) {
      for (const { requesterId, callback } of callbacks) {
        if (callback && typeof callback === 'function') {
          try {
            callback({
              success: false,
              error: 'Queue cleared',
              source: 'manual-clear',
              requesterId,
              notifiedAt: Date.now()
            });
          } catch (error) {
            config.smartLog('fail', `Error notifying cleared callback ${requesterId}: ${error.message}`);
          }
        }
      }
    }
    
    this.pendingRequests.clear();
    this.domainCallbacks.clear();
    
    await this.clearBufferFile();
    await this.clearGlobalQueueFile();
    
    config.smartLog('queue', `Cleared ${clearedProfileCount} profile updates, ${clearedGlobalCount} global queue entries, ${clearedWaitingCount} waiting requests, ${clearedCallbacksCount} callbacks`);
    
    return { 
      profileUpdates: clearedProfileCount, 
      globalQueue: clearedGlobalCount, 
      waitingRequests: clearedWaitingCount,
      callbacks: clearedCallbacksCount
    };
  }
}

module.exports = new ProfileQueueManager();