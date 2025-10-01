const DomainProfiler = require('./DomainProfiler');
const EmailQueueManager = require('./EmailQueueManager');
const EmailExplorer = require('./EmailExplorer');
const config = require('../config');

class EmailCoordinator {
  constructor() {
    this.profiler = new DomainProfiler();
    this.explorer = new EmailExplorer();
    this.activeExplorers = new Map();
    this.pendingCallbacks = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    await EmailQueueManager.start();
    config.smartLog('service', 'EmailCoordinator initialized');
    this.initialized = true;
  }

  async coordinatedExplore(url, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const { userId = 'anonymous', forceRefresh = false } = options;
    const domain = this.getDomainFromUrl(url);
    
    config.smartLog('scraper', `Coordinated email exploration requested for ${url} (user: ${userId})`);
  
    return new Promise(async (resolve, reject) => {
      try {
        if (!forceRefresh) {
          const cacheData = await this.explorer.getCachedResults(url);
          if (cacheData && !this.isCacheStale(cacheData)) {
            config.smartLog('cache', `Fresh email cache hit for ${url}`);
            await this.profiler.recordHit(url, 'cache');
            resolve({
              success: true,
              source: 'cache',
              data: cacheData,
              emailsFound: cacheData.stats?.uniqueEmails || 0,
              timestamp: Date.now()
            });
            return;
          }
        }
        
        const callback = (result) => {
          if (result.source === 'cache-notification') {
            config.smartLog('queue', `User ${userId} received email cache notification for ${domain}`);
            resolve({
              success: true,
              source: 'cache-shared',
              data: result.data,
              emailsFound: result.data.stats?.uniqueEmails || 0,
              notifiedAt: result.notifiedAt,
              notificationReceived: true,
              timestamp: Date.now()
            });
          } else if (result.success === false) {
            config.smartLog('fail', `User ${userId} email callback error for ${domain}: ${result.error}`);
            resolve({
              success: false,
              source: 'buffered-error',
              error: result.error,
              timestamp: Date.now()
            });
          }
        };
        
        const explorationSlot = await EmailQueueManager.requestExplorationSlot(domain, userId, callback);
        
        if (!explorationSlot.allowed) {
          config.smartLog('queue', `User ${userId} queued for email exploration ${domain}: ${explorationSlot.reason}`);
          
          if (explorationSlot.reason === 'buffered') {
            config.smartLog('queue', `User ${userId} will receive email results via intelligent buffer for ${domain}`);
            return;
          }
          
          resolve({
            success: false,
            source: 'queued',
            message: explorationSlot.message,
            queuePosition: explorationSlot.queuePosition,
            timestamp: Date.now()
          });
          return;
        }
        
        const result = await this.executeExploration(url, explorationSlot, userId, options);
        resolve(result);
        
      } catch (error) {
        config.smartLog('fail', `Coordinated email exploration failed for ${url}: ${error.message}`, { stackTrace: error.stack });
        reject(error);
      }
    });
  }

  async executeExploration(url, explorationSlot, userId, options = {}) {
    const domain = this.getDomainFromUrl(url);
    
    try {
      const result = await this.performSingleExploration(url, explorationSlot, userId, options);
      
      if (result.success && result.data) {
        await EmailQueueManager.releaseExplorationSlot(domain, explorationSlot.explorerId, result.data);
      } else {
        await EmailQueueManager.releaseExplorationSlot(domain, explorationSlot.explorerId, null);
      }
      
      return result;
      
    } catch (error) {
      try {
        await EmailQueueManager.releaseExplorationSlot(domain, explorationSlot.explorerId, null);
      } catch (releaseError) {
        config.smartLog('fail', `Failed to release exploration slot: ${releaseError.message}`, { stackTrace: releaseError.stack });
      }
      throw error;
    }
  }

  async performSingleExploration(url, explorationSlot, userId, options = {}) {
    const startTime = Date.now();
    let explorationResult = null;
    let sessionData = {
      stepUsed: 'email-exploration',
      startTime,
      endTime: null,
      success: false,
      emailsFound: 0,
      pagesExplored: 0,
      errorMessage: null,
      cacheCreated: false,
      explorerId: explorationSlot.explorerId
    };
  
    try {
      await this.profiler.recordHit(url, 'email-exploration');
      
      explorationResult = await this.explorer.exploreDomain(url, {
        maxDepth: options.maxDepth || 2,
        useCache: false,
        userId: userId
      });
      
      sessionData.endTime = Date.now();
      sessionData.success = true;
      sessionData.emailsFound = explorationResult.stats?.uniqueEmails || 0;
      sessionData.pagesExplored = explorationResult.stats?.totalPages || 0;
      sessionData.cacheCreated = true;
      
      config.smartLog('scraper', `Email exploration success for ${url}: ${sessionData.emailsFound} emails found on ${sessionData.pagesExplored} pages`);
      
      await this.profiler.recordScrapingSession(url, sessionData);
      
      return {
        success: true,
        source: 'fresh-exploration',
        data: explorationResult,
        emailsFound: sessionData.emailsFound,
        pagesExplored: sessionData.pagesExplored,
        processingTime: sessionData.endTime - sessionData.startTime,
        cacheCreated: sessionData.cacheCreated,
        timestamp: Date.now()
      };
        
    } catch (error) {
      config.smartLog('fail', `Single email exploration execution failed for ${url}: ${error.message}`, { stackTrace: error.stack });
      
      sessionData.endTime = Date.now();
      sessionData.success = false;
      sessionData.errorMessage = error.message;
      sessionData.emailsFound = 0;
      sessionData.cacheCreated = false;
  
      await this.profiler.recordScrapingSession(url, sessionData);
  
      return {
        success: false,
        source: 'exploration-error',
        error: error.message,
        emailsFound: 0,
        cacheCreated: false,
        timestamp: Date.now()
      };
    }
  }

  getDomainFromUrl(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      config.smartLog('fail', `Invalid URL: ${url}`);
      return url;
    }
  }

  isCacheStale(cacheData) {
    if (!cacheData.completedAt) return true;
    const ageInHours = (Date.now() - new Date(cacheData.completedAt).getTime()) / (1000 * 60 * 60);
    return ageInHours >= (24 * 365);
  }
  
  async getCoordinatorStats() {
    const profileStats = await this.profiler.getProfileStats();
    const queueStats = await EmailQueueManager.getDetailedStats();
    
    return {
      coordinator: {
        activeDomains: this.activeExplorers.size,
        initialized: this.initialized,
        timestamp: new Date().toISOString()
      },
      profiles: profileStats,
      queue: queueStats
    };
  }

  async clearDomainQueue(domain) {
    return await EmailQueueManager.clearQueue();
  }

  async resetCooldowns() {
    return await EmailQueueManager.clearQueue();
  }

  async shutdown() {
    config.smartLog('service', 'EmailCoordinator shutting down...');
    
    try {
      await EmailQueueManager.stop();
      config.smartLog('service', 'EmailQueueManager stopped');
    } catch (error) {
      config.smartLog('fail', 'Error stopping EmailQueueManager', { stackTrace: error.stack });
    }
    
    this.activeExplorers.clear();
    this.pendingCallbacks.clear();
    this.initialized = false;
    
    config.smartLog('service', 'EmailCoordinator shutdown complete');
  }
}

const emailCoordinator = new EmailCoordinator();

async function wrapExistingEmailExploration(originalFunction) {
  return async function(url, options = {}) {
    if (!emailCoordinator.initialized) {
      await emailCoordinator.initialize();
    }
    
    return await emailCoordinator.coordinatedExplore(url, options);
  };
}

module.exports = {
  EmailCoordinator,
  emailCoordinator,
  wrapExistingEmailExploration
};