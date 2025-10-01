const DomainProfiler = require('./scrapers/DomainProfiler');
const ProfileQueueManager = require('./scrapers/ProfileQueueManager');
const cacheManager = require('./cacheManager');
const config = require('./config');

class IntelligentScrapingOrchestrator {
  constructor() {
    this.profiler = new DomainProfiler();
    this.queueManager = ProfileQueueManager;
  }

  async initialize() {
    await this.queueManager.start();
    config.smartLog('buffer', 'Intelligent Scraping Orchestrator initialized');
  }

  async performIntelligentScraping(url, jobTitle, options = {}) {
    const { 
      userId = 'anonymous',
      priority = 'normal',
      forceRefresh = false 
    } = options;

    config.smartLog('steps', `Starting intelligent scraping for ${url} (user: ${userId})`);

    try {
      const cacheData = await cacheManager.getCachedData(url, { fallbackOnError: true });
      if (cacheData && !forceRefresh) {
        config.smartLog('cache', `Cache hit for ${url}, serving cached data`);
        await this.profiler.recordHit(url, 'cache');
        return {
          success: true,
          source: 'cache',
          data: cacheData,
          jobsFound: this.profiler.extractJobCountFromCache(cacheData),
          timestamp: Date.now()
        };
      }

      config.smartLog('cache', `Cache miss for ${url}, proceeding to scraping`);

      const scrapingSlot = await this.requestScrapingSlot(url, userId);
      if (!scrapingSlot.allowed) {
        return this.handleQueuedRequest(url, jobTitle, scrapingSlot, userId);
      }

      const scrapingResult = await this.executeScrapingWithProfile(url, jobTitle, scrapingSlot);
      
      await this.queueManager.releaseScrapingSlot(
        this.profiler.getDomainFromUrl(url), 
        scrapingSlot.scraperId
      );

      return scrapingResult;

    } catch (error) {
      config.smartLog('fail', `Intelligent scraping failed for ${url}: ${error.message}`);
      return {
        success: false,
        error: error.message,
        source: 'error',
        timestamp: Date.now()
      };
    }
  }

  async requestScrapingSlot(url, userId) {
    const domain = this.profiler.getDomainFromUrl(url);
    
    try {
      const slotResult = await this.queueManager.requestScrapingSlot(domain, userId);
      config.smartLog('buffer', `Scraping slot granted for ${domain}: ${slotResult.scraperId}`);
      return slotResult;
    } catch (error) {
      config.smartLog('buffer', `Scraping slot denied for ${domain}: ${error.message}`);
      return {
        allowed: false,
        reason: error.message,
        domain
      };
    }
  }

  async handleQueuedRequest(url, jobTitle, slotInfo, userId) {
    const domain = this.profiler.getDomainFromUrl(url);
    const waitingCount = this.queueManager.getWaitingRequestsCount(domain);
    
    config.smartLog('polling', `Request queued for ${domain}: ${waitingCount} users waiting`);
    
    if (waitingCount > 10) {
      const fallbackCache = await cacheManager.getCachedData(url);
      if (fallbackCache) {
        config.smartLog('cache', `High queue load, serving stale cache for ${domain}`);
        return {
          success: true,
          source: 'stale-cache',
          data: fallbackCache,
          jobsFound: this.profiler.extractJobCountFromCache(fallbackCache),
          waitingCount,
          timestamp: Date.now()
        };
      }
    }

    return {
      success: false,
      queued: true,
      reason: slotInfo.reason,
      waitTime: slotInfo.waitTime,
      waitingCount,
      domain,
      timestamp: Date.now()
    };
  }

  async executeScrapingWithProfile(url, jobTitle, scrapingSlot) {
    const startTime = Date.now();
    let scrapingMethod = null;
    let wasHeadless = false;
    let contentText = '';
    let errorMessage = null;
    let platform = null;
    let cacheCreated = false;
    let jobsFound = 0;

    try {
      await this.profiler.recordHit(url, 'scraping');
      
      const profileRecommendation = await this.profiler.shouldUseCachedProfile(url);
      
      if (profileRecommendation.useProfile) {
        config.smartLog('fast-track', `Using profile recommendation for ${url}: ${profileRecommendation.step}`);
        scrapingMethod = profileRecommendation.step;
        wasHeadless = profileRecommendation.headless;
      } else {
        config.smartLog('steps', `Profile not available for ${url}: ${profileRecommendation.reason}`);
        scrapingMethod = 'adaptive-detection';
      }

      const scrapingResult = await this.performActualScraping(url, jobTitle, {
        method: scrapingMethod,
        headless: wasHeadless,
        language: profileRecommendation.language || 'en',
        aws: profileRecommendation.aws || 'lambda'
      });

      contentText = scrapingResult.text || '';
      platform = scrapingResult.platform;
      errorMessage = scrapingResult.error;
      
      if (scrapingResult.data && scrapingResult.data.links) {
        const saveSuccess = await cacheManager.saveCache(url, scrapingResult.data);
        cacheCreated = saveSuccess;
        jobsFound = this.profiler.extractJobCountFromCache(scrapingResult.data);
        
        config.smartLog('cache', `Cache creation for ${url}: ${cacheCreated ? 'SUCCESS' : 'FAILED'} (${jobsFound} jobs)`);
      }

      const endTime = Date.now();
      const sessionData = {
        stepUsed: scrapingMethod,
        wasHeadless,
        startTime,
        endTime,
        success: scrapingResult.success,
        contentText,
        errorMessage,
        jobsFound,
        platform,
        cacheCreated,
        scraperId: scrapingSlot.scraperId
      };

      const updatedProfile = await this.profiler.recordScrapingSession(url, sessionData);
      
      const isEffectiveSuccess = cacheCreated && jobsFound > 0;
      const finalSuccess = scrapingResult.success || isEffectiveSuccess;

      config.smartLog('win', `Scraping completed for ${url}: success=${finalSuccess}, jobs=${jobsFound}, cache=${cacheCreated}`);

      return {
        success: finalSuccess,
        source: 'fresh-scraping',
        data: scrapingResult.data,
        jobsFound,
        method: scrapingMethod,
        processingTime: endTime - startTime,
        profile: {
          step: updatedProfile.step,
          successRate: updatedProfile.successRate,
          aws: updatedProfile.aws
        },
        cacheCreated,
        timestamp: Date.now()
      };

    } catch (error) {
      config.smartLog('fail', `Scraping execution failed for ${url}: ${error.message}`);
      
      const endTime = Date.now();
      const sessionData = {
        stepUsed: scrapingMethod || 'unknown',
        wasHeadless,
        startTime,
        endTime,
        success: false,
        contentText,
        errorMessage: error.message,
        jobsFound: 0,
        platform,
        cacheCreated: false,
        scraperId: scrapingSlot.scraperId
      };

      await this.profiler.recordScrapingSession(url, sessionData);

      return {
        success: false,
        source: 'scraping-error',
        error: error.message,
        method: scrapingMethod,
        timestamp: Date.now()
      };
    }
  }

  async performActualScraping(url, jobTitle, options) {
    const { method, headless, language, aws } = options;
    
    config.smartLog('steps', `Executing scraping: method=${method}, headless=${headless}, aws=${aws}`);

    try {
      if (aws === 'fargate') {
        return await this.executeOnFargate(url, jobTitle, { method, headless, language });
      } else {
        return await this.executeOnLambda(url, jobTitle, { method, headless, language });
      }
    } catch (error) {
      config.smartLog('fail', `Scraping method ${method} failed: ${error.message}`);
      
      if (method !== 'adaptive-fallback') {
        config.smartLog('retry', `Falling back to adaptive scraping for ${url}`);
        return await this.executeAdaptiveFallback(url, jobTitle);
      }
      
      throw error;
    }
  }

  async executeOnLambda(url, jobTitle, options) {
    config.smartLog('steps', `Executing on Lambda: ${url}`);
    
    const unifiedScrapingService = require('./scrapers/unifiedScrapingService');
    return await unifiedScrapingService.scrapeWithLambda(url, jobTitle, options);
  }

  async executeOnFargate(url, jobTitle, options) {
    config.smartLog('steps', `Executing on Fargate: ${url}`);
    
    const AwsServiceDecider = require('./aws/AwsServiceDecider');
    return await AwsServiceDecider.executeScrapingOnFargate(url, jobTitle, options);
  }

  async executeAdaptiveFallback(url, jobTitle) {
    config.smartLog('retry', `Executing adaptive fallback for: ${url}`);
    
    const adaptiveScraper = require('./scrapers/adaptiveScraper');
    const result = await adaptiveScraper.scrapeAdaptively(url, jobTitle);
    
    if (result.data && result.data.links && result.data.links.length > 0) {
      result.success = true;
      config.smartLog('win', `Adaptive fallback successful: ${result.data.links.length} jobs found`);
    }
    
    return result;
  }

  async getSystemStats() {
    const profileStats = await this.profiler.getProfileStats();
    const queueStats = await this.queueManager.getDetailedStats();
    const cacheStats = await cacheManager.getCacheStats();
    
    return {
      profiles: profileStats,
      queue: queueStats,
      cache: cacheStats,
      timestamp: new Date().toISOString()
    };
  }

  async forceReprofileAllDomains() {
    config.smartLog('domain-profile', 'Starting forced reprofiling of all domains...');
    
    await this.profiler.loadCurrentProfiles();
    let reprofiledCount = 0;
    
    for (const [domain, profile] of this.profiler.currentProfiles.entries()) {
      profile.needsReprofiling = true;
      profile.reprofilingReason = 'forced_manual_reprofiling';
      profile.reprofilingTriggeredAt = new Date().toISOString();
      reprofiledCount++;
    }
    
    await this.profiler.saveCurrentProfiles();
    config.smartLog('win', `Forced reprofiling completed: ${reprofiledCount} domains marked`);
    
    return reprofiledCount;
  }

  async optimizeForHighLoad() {
    config.smartLog('buffer', 'Optimizing system for high load (1000+ users)...');
    
    await this.queueManager.cleanupExpiredGlobalQueue();
    
    const oldCacheCleared = await cacheManager.clearExpiredCache();
    config.smartLog('cache', `Cleared ${oldCacheCleared} expired cache entries`);
    
    const oldProfilesCleared = await this.profiler.clearOldProfiles(2);
    config.smartLog('domain-profile', `Cleared ${oldProfilesCleared} old profile files`);
    
    const stats = await this.getSystemStats();
    config.smartLog('win', `System optimized: ${stats.profiles.totalDomains} domains, ${stats.queue.globalScrapingQueueSize} active scrapers`);
    
    return stats;
  }

  async handleEmergencyShutdown() {
    config.smartLog('fail', 'Emergency shutdown initiated...');
    
    try {
      await this.queueManager.stop();
      await this.profiler.saveCurrentProfiles();
      config.smartLog('win', 'Emergency shutdown completed successfully');
      return true;
    } catch (error) {
      config.smartLog('fail', `Emergency shutdown failed: ${error.message}`);
      await this.queueManager.emergencyRecovery();
      return false;
    }
  }
}

module.exports = IntelligentScrapingOrchestrator;