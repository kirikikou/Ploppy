const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const profilingConfig = require('../config/profiling');
const { safeWriteJson } = require('../utils/atomicFS');
const loggingService = require('../services/LoggingService');

class DomainProfiler {
  constructor() {
    if (DomainProfiler.instance) {
      return DomainProfiler.instance;
    }

    this.profilesCache = new Map();
    this.writeLock = new Map();
    this.initialized = false;
    
    this.ensureProfilesDir();

    DomainProfiler.instance = this;
  }

  async ensureProfilesDir() {
    if (this.initialized) return;
    
    try {
      await fs.access(profilingConfig.PROFILES_DIR);
      loggingService.log('cache', `Profiles directory exists: ${profilingConfig.PROFILES_DIR}`);
    } catch (error) {
      loggingService.log('cache', `Creating profiles directory: ${profilingConfig.PROFILES_DIR}`);
      await fs.mkdir(profilingConfig.PROFILES_DIR, { recursive: true });
    }
    
    this.initialized = true;
  }

  normalizeUrl(url) {
    try {
      let normalized = url
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .toLowerCase();

      normalized = normalized
        .replace(/[\/\?&=:]/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');

      if (normalized.length > profilingConfig.MAX_URL_LENGTH) {
        normalized = normalized.substring(0, profilingConfig.MAX_URL_LENGTH);
      }

      return normalized;
    } catch (error) {
      loggingService.log('fail', `Error normalizing URL: ${error.message}`);
      return url.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, profilingConfig.MAX_URL_LENGTH);
    }
  }

  generateHash(url) {
    const hash = crypto
      .createHash('sha256')
      .update(url + profilingConfig.SECRET_SALT)
      .digest('hex')
      .substring(0, profilingConfig.HASH_LENGTH);
    
    return hash;
  }

  getProfileId(url) {
    const normalized = this.normalizeUrl(url);
    const hash = this.generateHash(url);
    const id = `${normalized}_${hash}`;
    
    loggingService.log('cache', `Generated profile ID for ${url}: ${id}`);
    return id;
  }

  getProfilePath(url) {
    const id = this.getProfileId(url);
    const filepath = path.join(profilingConfig.PROFILES_DIR, `${id}.json`);
    return filepath;
  }

  async loadProfile(url) {
    const filepath = this.getProfilePath(url);
    const id = this.getProfileId(url);

    if (this.profilesCache.has(id)) {
      loggingService.log('cache', `Profile loaded from memory cache: ${id}`);
      return this.profilesCache.get(id);
    }

    try {
      const data = await fs.readFile(filepath, 'utf8');
      const profile = JSON.parse(data);
      
      this.profilesCache.set(id, profile);
      loggingService.log('cache', `Profile loaded from disk: ${id}`);
      
      return profile;
    } catch (error) {
      if (error.code === 'ENOENT') {
        loggingService.log('cache', `Profile not found: ${id}`);
        return null;
      }
      loggingService.log('fail', `Error loading profile ${id}: ${error.message}`);
      return null;
    }
  }

  async saveProfile(url, profileData) {
    const filepath = this.getProfilePath(url);
    const id = this.getProfileId(url);
    
    if (this.writeLock.has(id)) {
      loggingService.log('cache', `Save already in progress for ${id}, waiting`);
      await this.writeLock.get(id);
      return true;
    }

    const writePromise = this._performSaveProfile(filepath, id, profileData);
    this.writeLock.set(id, writePromise);

    try {
      const result = await writePromise;
      return result;
    } finally {
      this.writeLock.delete(id);
    }
  }

  async _performSaveProfile(filepath, id, profileData) {
    try {
      await this.ensureProfilesDir();
      
      const dataToSave = {
        ...profileData,
        _profileId: id,
        _lastUpdate: new Date().toISOString()
      };

      await safeWriteJson(filepath, dataToSave);
      
      this.profilesCache.set(id, dataToSave);
      
      loggingService.log('cache', `Profile saved: ${id} (${Object.keys(dataToSave).length} fields)`);
      return true;
    } catch (error) {
      loggingService.log('fail', `Error saving profile ${id}: ${error.message}`);
      return false;
    }
  }

  async deleteProfile(url) {
    const filepath = this.getProfilePath(url);
    const id = this.getProfileId(url);

    try {
      await fs.unlink(filepath);
      this.profilesCache.delete(id);
      loggingService.log('cache', `Profile deleted: ${id}`);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        loggingService.log('cache', `Profile already deleted: ${id}`);
        return true;
      }
      loggingService.log('fail', `Error deleting profile ${id}: ${error.message}`);
      return false;
    }
  }

  async listProfiles(options = {}) {
    const { limit = 100, offset = 0 } = options;

    try {
      await this.ensureProfilesDir();
      const files = await fs.readdir(profilingConfig.PROFILES_DIR);
      const profileFiles = files.filter(f => f.endsWith('.json'));

      const profiles = [];
      const filesToProcess = profileFiles.slice(offset, offset + limit);

      for (const file of filesToProcess) {
        try {
          const filepath = path.join(profilingConfig.PROFILES_DIR, file);
          const data = await fs.readFile(filepath, 'utf8');
          const profile = JSON.parse(data);
          profiles.push(profile);
        } catch (error) {
          loggingService.log('fail', `Error reading profile ${file}: ${error.message}`);
        }
      }

      loggingService.log('cache', `Listed ${profiles.length} profiles (total: ${profileFiles.length})`);
      return profiles;
    } catch (error) {
      loggingService.log('fail', `Error listing profiles: ${error.message}`);
      return [];
    }
  }

  async cleanupOldProfiles(daysOld = null) {
    const configDaysOld = daysOld || profilingConfig.TTL_DAYS;
    const cutoffTime = Date.now() - (configDaysOld * 24 * 60 * 60 * 1000);

    loggingService.log('cache', `Starting cleanup of profiles older than ${configDaysOld} days`);

    try {
      await this.ensureProfilesDir();
      const files = await fs.readdir(profilingConfig.PROFILES_DIR);
      const profileFiles = files.filter(f => f.endsWith('.json'));

      let deletedCount = 0;

      for (const file of profileFiles) {
        try {
          const filepath = path.join(profilingConfig.PROFILES_DIR, file);
          const data = await fs.readFile(filepath, 'utf8');
          const profile = JSON.parse(data);

          const lastSeen = profile.lastSeen || profile._lastUpdate;
          if (lastSeen) {
            const lastSeenTime = new Date(lastSeen).getTime();
            if (lastSeenTime < cutoffTime) {
              await fs.unlink(filepath);
              deletedCount++;
              loggingService.log('cache', `Deleted old profile: ${file}`);
            }
          }
        } catch (error) {
          loggingService.log('fail', `Error processing profile ${file}: ${error.message}`);
        }
      }

      loggingService.log('win', `Cleanup completed: ${deletedCount} profiles deleted`);
      return deletedCount;
    } catch (error) {
      loggingService.log('fail', `Error during cleanup: ${error.message}`);
      return 0;
    }
  }

  getDomainFromUrl(url) {
    try {
      const urlObj = new URL(url);
      let cleanUrl = urlObj.hostname.toLowerCase();
      
      if (cleanUrl.startsWith('www.')) {
        cleanUrl = cleanUrl.substring(4);
      }
      
      let pathname = urlObj.pathname;
      if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      if (pathname.startsWith('/')) {
        pathname = pathname.substring(1);
      }
      
      if (pathname) {
        const pathParts = pathname.split('/').filter(p => p && p.length > 0);
        const relevantParts = pathParts.slice(0, 2);
        if (relevantParts.length > 0) {
          cleanUrl += '/' + relevantParts.join('/');
        }
      }
      
      return cleanUrl;
    } catch (error) {
      return url.toLowerCase().replace(/[^a-z0-9.-\/]/g, '_').substring(0, 200);
    }
  }

  createNewProfile(domain, url, preferredLanguage = 'en') {
    return {
      domain,
      url,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      step: null,
      language: preferredLanguage,
      platform: null,
      attempts: 0,
      successes: 0,
      failures: 0,
      avgTime: 0,
      successRate: 0,
      headless: false,
      aws: 'lambda',
      hitCount: 0,
      cacheHits: 0,
      scrapingHits: 0,
      lastHit: null,
      lastJobs: 0,
      lastSuccessfulScraping: null,
      needsReprofiling: false,
      reprofilingReason: null,
      reprofilingTriggeredAt: null,
      lastScrapingAttempt: null,
      activeScrapeCount: 0
    };
  }

  async recordHit(url, source = 'scraping') {
    const existingProfile = await this.loadProfile(url) || this.createNewProfile(this.getDomainFromUrl(url), url);

    existingProfile.lastSeen = new Date().toISOString();
    existingProfile.hitCount++;
    existingProfile.lastHit = new Date().toISOString();
    
    if (source === 'cache') {
      existingProfile.cacheHits++;
    } else if (source === 'cache-minimum') {
      existingProfile.cacheHits++;
      loggingService.log('cache', `Minimum cache hit recorded for ${existingProfile.domain}`);
    } else if (source === 'scraping') {
      existingProfile.scrapingHits++;
    }

    await this.saveProfile(url, existingProfile);
    
    loggingService.log('cache', `Hit recorded for ${existingProfile.domain}: total=${existingProfile.hitCount} (cache=${existingProfile.cacheHits}, scraping=${existingProfile.scrapingHits})`);
    return existingProfile;
  }

  async getDomainProfile(url) {
    const profile = await this.loadProfile(url);
    
    if (profile && this.isProfileExpiredMonthly(profile)) {
      profile.needsReprofiling = true;
      profile.reprofilingReason = 'monthly_reprofiling_required';
      profile.reprofilingTriggeredAt = new Date().toISOString();
      await this.saveProfile(url, profile);
      
      loggingService.log('cache', `Domain ${profile.domain} marked for monthly re-profiling`);
    }
    
    return profile;
  }

  async shouldUseCachedProfile(url) {
    const profile = await this.loadProfile(url);
    
    if (!profile) {
      return { useProfile: false, reason: 'No profile exists' };
    }
    
    if (!profile.step) {
      return { useProfile: false, reason: 'No preferred step identified' };
    }
    
    const actualSuccessRate = profile.attempts > 0 ? 
      Math.round((profile.successes / profile.attempts) * 100) : 0;
    
    if (actualSuccessRate < profilingConfig.SUCCESS_RATE_THRESHOLD) {
      return { useProfile: false, reason: `Success rate too low (${actualSuccessRate}%)` };
    }
    
    if (this.isProfileExpiredMonthly(profile)) {
      return { useProfile: false, reason: 'Profile expired (>30 days)' };
    }
    
    const ADAPTIVE_SCRAPER_METHODS = ['axios-simple', 'playwright-basic', 'playwright-enhanced'];
    
    if (ADAPTIVE_SCRAPER_METHODS.includes(profile.step) && actualSuccessRate >= 70) {
      loggingService.log('fast-track', `FAST-TRACK APPROVED for ${profile.domain}: ${profile.step} (${actualSuccessRate}% success)`);
      return {
        useProfile: true,
        step: profile.step,
        language: profile.language,
        platform: profile.platform,
        headless: profile.headless,
        aws: profile.aws,
        successRate: actualSuccessRate,
        avgTime: profile.avgTime,
        profile: profile,
        needsReprofiling: profile.needsReprofiling
      };
    }
    
    if (profile.attempts < profilingConfig.FAST_TRACK_MIN_ATTEMPTS) {
      return { useProfile: false, reason: 'Insufficient attempts for fast-track' };
    }
    
    if (profile.needsReprofiling && actualSuccessRate < 80) {
      return { useProfile: false, reason: profile.reprofilingReason || 'Needs reprofiling' };
    }
    
    loggingService.log('fast-track', `FAST-TRACK APPROVED for ${profile.domain}: ${profile.step} (${actualSuccessRate}% success)`);
    return {
      useProfile: true,
      step: profile.step,
      language: profile.language,
      platform: profile.platform,
      headless: profile.headless,
      aws: profile.aws,
      successRate: actualSuccessRate,
      avgTime: profile.avgTime,
      profile: profile,
      needsReprofiling: profile.needsReprofiling
    };
  }

  normalizeStepName(stepName, platform = null) {
    if (!stepName) return null;
    
    if (stepName === 'StepBasedScraper' && platform) {
      const platformLower = platform.toLowerCase();
      
      if (platformLower.includes('recruitee')) return 'recruitee-step';
      if (platformLower.includes('bamboo')) return 'bamboohr-step';
      if (platformLower.includes('workable')) return 'workable-step';
      if (platformLower.includes('greenhouse')) return 'greenhouse-step';
      if (platformLower.includes('lever')) return 'lever-step';
      if (platformLower.includes('smart')) return 'smartrecruiters-step';
      if (platformLower.includes('workday')) return 'workday-step';
      if (platformLower.includes('icims')) return 'icims-step';
      if (platformLower.includes('jazz')) return 'jazzhr-step';
      if (platformLower.includes('adp')) return 'adp-step';
      if (platformLower.includes('brass')) return 'brassring-step';
      if (platformLower.includes('power')) return 'powershift-step';
      if (platformLower.includes('zoho')) return 'zoho-recruit-step';
    }
    
    const stepNameLower = stepName.toLowerCase();
    
    if (stepNameLower.includes('playwright-enhanced') || stepNameLower.includes('playwright_enhanced')) {
      return 'robust-scraper';
    }
    if (stepNameLower.includes('lightweight') && stepNameLower.includes('variants')) {
      return 'lightweight-variants';
    }
    if (stepNameLower.includes('wordpress') && stepNameLower.includes('lightweight')) {
      return 'wordpress-lightweight';
    }
    if (stepNameLower.includes('wordpress') && stepNameLower.includes('headless')) {
      return 'wordpress-headless';
    }
    if (stepNameLower.includes('headless') && stepNameLower.includes('rendering')) {
      return 'headless-rendering';
    }
    if (stepNameLower.includes('iframe')) {
      return 'iframe-aware-rendering';
    }
    
    return stepName;
  }

  isStepHeadless(stepName) {
    if (!stepName) return false;
    
    const headlessSteps = [
      'headless-rendering', 'iframe-aware-rendering', 'adaptive-fallback',
      'bamboohr-step', 'workday-step', 'workable-step', 'greenhouse-step',
      'brassring-step', 'icims-step', 'lever-step', 'smartrecruiters-step',
      'jazzhr-step', 'adp-step', 'powershift-step', 'zoho-recruit-step',
      'teamtailor-step', 'wordpress-headless'
    ];
    
    return headlessSteps.some(pattern => stepName.includes(pattern.replace('-step', '')));
  }

  determineAwsRecommendation(stepName, requiresHeadless, avgTime) {
    if (requiresHeadless || this.isStepHeadless(stepName)) {
      return 'fargate';
    }
    
    const fifteenMinutesMs = 15 * 60 * 1000;
    if (avgTime && avgTime > fifteenMinutesMs) {
      return 'fargate';
    }
    
    return 'lambda';
  }

  selectBestStep(currentStep, normalizedStepName, originalStepUsed) {
    const STEP_PRIORITY = {
      'axios-simple': 8,
      'playwright-basic': 7,
      'playwright-enhanced': 6,
      'headless-rendering': 5,
      'brassring-step': 9,
      'greenhouse-step': 9,
      'workday-step': 9,
      'bamboohr-step': 9,
      'workable-step': 9,
      'lever-step': 9,
      'smartrecruiters-step': 9,
      'icims-step': 9,
      'jazzhr-step': 9,
      'recruitee-step': 9,
      'adaptive-fallback': 1,
      'AdaptiveScraper': 2,
      'StepBasedScraper': 3
    };
    
    const currentPriority = STEP_PRIORITY[currentStep] || 0;
    const newPriority = STEP_PRIORITY[normalizedStepName] || 0;
    
    if (newPriority > currentPriority) {
      loggingService.log('cache', `Step priority upgrade: ${currentStep}(${currentPriority}) -> ${normalizedStepName}(${newPriority})`);
      return normalizedStepName;
    }
    
    return currentStep || normalizedStepName;
  }

  async recordScrapingSession(url, sessionData) {
    const providedLanguage = sessionData.detectedLanguage || sessionData.language || null;
    return await this.recordScrapingSessionWithProvidedLanguage(url, sessionData, providedLanguage);
  }

  async recordScrapingSessionWithProvidedLanguage(url, sessionData, providedLanguage) {
    const domain = this.getDomainFromUrl(url);
    const validProvidedLanguage = (providedLanguage && providedLanguage !== 'unknown' && providedLanguage !== '') ? providedLanguage : null;
    
    loggingService.log('cache', `Recording session with language: ${validProvidedLanguage || 'none provided'}`);
    
    const existingProfile = await this.loadProfile(url) || this.createNewProfile(domain, url, validProvidedLanguage || 'en');

    const {
      stepUsed,
      wasHeadless = false,
      startTime,
      endTime,
      success = false,
      errorMessage = null,
      jobsFound = 0,
      platform = null,
      cacheCreated = false,
      scraperId = null,
      isMinimumCache = false
    } = sessionData;

    const processingTime = endTime && startTime ? endTime - startTime : 0;
    const normalizedStepName = this.normalizeStepName(stepUsed, platform);

    const originalLanguage = existingProfile.language;
    
    if (validProvidedLanguage && validProvidedLanguage !== 'en' && validProvidedLanguage !== 'unknown') {
      existingProfile.language = validProvidedLanguage;
      if (originalLanguage !== validProvidedLanguage) {
        loggingService.log('langue', `LANGUAGE UPDATED for ${domain}: ${originalLanguage} -> ${validProvidedLanguage}`);
      }
    } else if (!existingProfile.language || existingProfile.language === 'en') {
      const fallbackLanguage = validProvidedLanguage || 'en';
      existingProfile.language = fallbackLanguage;
    }

    existingProfile.lastSeen = new Date().toISOString();
    existingProfile.attempts++;
    
    if (isMinimumCache === true) {
      loggingService.log('cache', `MINIMUM CACHE session detected for ${domain}`);
      existingProfile.failures++;
    } else {
      const isEffectiveSuccess = (cacheCreated && jobsFound > 0) || (success && jobsFound > 0);
      
      if (isEffectiveSuccess) {
        existingProfile.successes++;
        existingProfile.lastSuccessfulScraping = new Date().toISOString();
        
        if (existingProfile.needsReprofiling) {
          existingProfile.needsReprofiling = false;
          existingProfile.reprofilingReason = null;
          existingProfile.reprofilingTriggeredAt = null;
          existingProfile.failures = 0;
          loggingService.log('win', `Domain ${domain} reprofiling completed successfully`);
        }
        
        if (normalizedStepName) {
          const newStep = this.selectBestStep(existingProfile.step, normalizedStepName, stepUsed);
          if (newStep !== existingProfile.step) {
            existingProfile.step = newStep;
          }
        }
        
        if (wasHeadless || this.isStepHeadless(normalizedStepName)) {
          existingProfile.headless = true;
        }
        
        if (platform) {
          existingProfile.platform = platform;
        }
        
        if (processingTime > 0) {
          if (existingProfile.avgTime === 0) {
            existingProfile.avgTime = processingTime;
          } else {
            existingProfile.avgTime = Math.round((existingProfile.avgTime + processingTime) / 2);
          }
        }
        
        if (jobsFound > 0) {
          existingProfile.lastJobs = jobsFound;
        }
      } else {
        existingProfile.failures++;
        
        if (profilingConfig.AUTO_REPROFILING_ENABLED && 
            existingProfile.failures >= profilingConfig.FAILURE_THRESHOLD) {
          existingProfile.needsReprofiling = true;
          existingProfile.reprofilingReason = `${existingProfile.failures}_consecutive_failures`;
          existingProfile.reprofilingTriggeredAt = new Date().toISOString();
          loggingService.log('cache', `Domain ${domain} marked for re-profiling: ${existingProfile.failures} failures`);
        }
      }
    }
    
    existingProfile.successRate = existingProfile.attempts > 0 ? 
      Math.round((existingProfile.successes / existingProfile.attempts) * 100) : 0;
    
    existingProfile.aws = this.determineAwsRecommendation(existingProfile.step, existingProfile.headless, existingProfile.avgTime);
    
    await this.saveProfile(url, existingProfile);
    
    loggingService.log('cache', `Profile updated for ${domain}: ${existingProfile.step} (${existingProfile.aws}) - lang: ${existingProfile.language}, success: ${existingProfile.successRate}%`);
    
    return existingProfile;
  }

  async updateProfileFromCache(url, cacheData) {
    if (!cacheData) return;
    
    if (cacheData._cacheMetadata && cacheData._cacheMetadata.isMinimumCache === true) {
      loggingService.log('cache', `Profile update skipped (minimum cache) for ${url}`);
      return;
    }
    
    if (cacheData.isMinimumCache === true || cacheData.isEmpty === true) {
      loggingService.log('cache', `Profile update skipped (minimum cache flag) for ${url}`);
      return;
    }
    
    const domain = this.getDomainFromUrl(url);
    const existingProfile = await this.loadProfile(url) || this.createNewProfile(domain, url);
    
    if (existingProfile.step && existingProfile.lastSuccessfulScraping) {
      return;
    }
    
    if (cacheData.detectedLanguage && !existingProfile.language) {
      existingProfile.language = cacheData.detectedLanguage;
    }
    
    if (cacheData.detectedPlatform && !existingProfile.platform) {
      existingProfile.platform = cacheData.detectedPlatform;
    }
    
    if (cacheData.method && !existingProfile.step) {
      const normalizedStep = this.normalizeStepName(cacheData.method, cacheData.detectedPlatform);
      if (normalizedStep) {
        existingProfile.step = normalizedStep;
        existingProfile.headless = this.isStepHeadless(normalizedStep);
        existingProfile.aws = this.determineAwsRecommendation(normalizedStep, existingProfile.headless, existingProfile.avgTime);
      }
    }
    
    existingProfile.lastSeen = new Date().toISOString();
    
    await this.saveProfile(url, existingProfile);
    
    loggingService.log('cache', `Profile updated from cache for ${domain}: step=${existingProfile.step}, lang=${existingProfile.language}`);
  }

  isProfileExpiredMonthly(profile) {
    if (!profile.lastSuccessfulScraping) return false;
    
    const lastScrapingDate = new Date(profile.lastSuccessfulScraping);
    const monthlyThreshold = new Date(Date.now() - (profilingConfig.MONTHLY_REPROFILING_DAYS * 24 * 60 * 60 * 1000));
    
    return lastScrapingDate < monthlyThreshold;
  }

  async markBackgroundScrapeCompleted(url, success = true) {
    const profile = await this.loadProfile(url);
    
    if (profile) {
      profile.lastBackgroundScrape = new Date().toISOString();
      await this.saveProfile(url, profile);
      loggingService.log('cache', `Background scrape marked for ${profile.domain}: ${success ? 'success' : 'failure'}`);
    }
  }

  async getProfileStats() {
    try {
      await this.ensureProfilesDir();
      const files = await fs.readdir(profilingConfig.PROFILES_DIR);
      const profileFiles = files.filter(f => f.endsWith('.json'));

      const stats = {
        totalDomains: profileFiles.length,
        lambdaRecommended: 0,
        fargateRecommended: 0,
        headlessRequired: 0,
        averageSuccessRate: 0,
        totalHits: 0,
        totalCacheHits: 0,
        totalScrapingHits: 0,
        needsReprofiling: 0,
        monthlyReprofilingRequired: 0,
        languageDistribution: {},
        stepDistribution: {},
        platformDistribution: {}
      };

      let totalSuccessRate = 0;

      for (const file of profileFiles.slice(0, 1000)) {
        try {
          const filepath = path.join(profilingConfig.PROFILES_DIR, file);
          const data = await fs.readFile(filepath, 'utf8');
          const profile = JSON.parse(data);

          if (profile.aws === 'lambda') stats.lambdaRecommended++;
          if (profile.aws === 'fargate') stats.fargateRecommended++;
          if (profile.headless) stats.headlessRequired++;
          if (profile.needsReprofiling) stats.needsReprofiling++;
          if (this.isProfileExpiredMonthly(profile)) stats.monthlyReprofilingRequired++;
          
          totalSuccessRate += profile.successRate || 0;
          stats.totalHits += profile.hitCount || 0;
          stats.totalCacheHits += profile.cacheHits || 0;
          stats.totalScrapingHits += profile.scrapingHits || 0;
          
          if (profile.step) {
            stats.stepDistribution[profile.step] = (stats.stepDistribution[profile.step] || 0) + 1;
          }
          
          if (profile.language) {
            stats.languageDistribution[profile.language] = (stats.languageDistribution[profile.language] || 0) + 1;
          }
          
          if (profile.platform) {
            stats.platformDistribution[profile.platform] = (stats.platformDistribution[profile.platform] || 0) + 1;
          }
        } catch (error) {
          loggingService.log('fail', `Error reading profile ${file}: ${error.message}`);
        }
      }

      stats.averageSuccessRate = stats.totalDomains > 0 ? Math.round(totalSuccessRate / stats.totalDomains) : 0;
      
      loggingService.log('monitoring', `Profile stats calculated: ${stats.totalDomains} domains`);
      return stats;
    } catch (error) {
      loggingService.log('fail', `Error getting profile stats: ${error.message}`);
      return null;
    }
  }

  static getInstance() {
    if (!DomainProfiler.instance) {
      DomainProfiler.instance = new DomainProfiler();
    }
    return DomainProfiler.instance;
  }
}

DomainProfiler.instance = null;

module.exports = DomainProfiler;