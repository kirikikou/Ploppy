const StepBasedScraper = require('./StepBasedScraper');
const AdaptiveScraper = require('./adaptiveScraper');
const RobustScraper = require('./robustScraper');
const DomainProfiler = require('./DomainProfiler');
const ProfileQueueManager = require('./ProfileQueueManager');
const { getCachedData, saveCache, CACHE_QUALITY_TYPES } = require('../cacheManager');
const dictionariesManager = require('../dictionaries');
const IndependentLanguageDetector = require('../dictionaries/IndependentLanguageDetector');
const config = require('../config');
const loggingService = require('../services/LoggingService');

class ScrapingCoordinator {
  constructor() {
    if (ScrapingCoordinator.instance) {
      return ScrapingCoordinator.instance;
    }

    this.stepBasedScraper = null;
    this.adaptiveScraper = null;
    this.robustScraper = null;
    this.domainProfiler = null;
    this.initialized = false;
    this.initializationStarted = false;
    
    this.adaptiveMethodMap = {
      'axios-simple': 'scrapeWithAxios',
      'playwright-basic': 'scrapeWithPlaywright',
      'playwright-enhanced': 'scrapeWithPlaywrightEnhanced'
    };
    
    this.complexDomains = dictionariesManager.complexDomains;
    this.knownJobPlatforms = dictionariesManager.knownJobPlatforms;

    ScrapingCoordinator.instance = this;
  }

  static getInstance() {
    if (!ScrapingCoordinator.instance) {
      ScrapingCoordinator.instance = new ScrapingCoordinator();
    }
    return ScrapingCoordinator.instance;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    
    if (this.initializationStarted) {
      loggingService.buffer('ScrapingCoordinator initialization already in progress, waiting...');
      while (this.initializationStarted && !this.initialized) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return;
    }
    
    this.initializationStarted = true;
    
    try {
      loggingService.buffer('Initializing ScrapingCoordinator singletons...');
      
      this.stepBasedScraper = StepBasedScraper.getInstance();
      this.adaptiveScraper = AdaptiveScraper.getInstance();
      this.robustScraper = RobustScraper.getInstance();
      this.domainProfiler = DomainProfiler.getInstance();
      
      await this.robustScraper.initialize();
      
      this.initialized = true;
      loggingService.win('ScrapingCoordinator singletons initialized');
    } finally {
      this.initializationStarted = false;
    }
  }

  async coordinatedScrape(url, sessionId, options = {}, userId = 'anonymous') {
    await this.ensureInitialized();
    
    const queueDomain = this.extractHostnameForQueue(url);
    
    loggingService.setSessionContext(sessionId, {
      userId,
      url,
      domain: queueDomain,
      step: 'queue',
      attempt: 1
    });
    
    try {
      const slotRequest = await ProfileQueueManager.requestScrapingSlot(queueDomain, userId);
      
      if (!slotRequest.allowed) {
        loggingService.queue('denied', queueDomain, {
          reason: slotRequest.reason,
          waitTime: slotRequest.waitTime,
          position: slotRequest.queuePosition
        });
        return this.handleQueuedRequest(slotRequest, url, sessionId);
      }
      
      loggingService.queue('granted', queueDomain, { scraperId: slotRequest.scraperId });
      
      try {
        const result = await this.executeScraping(url, sessionId, options);
        
        await ProfileQueueManager.releaseScrapingSlot(queueDomain, slotRequest.scraperId, result);
        loggingService.queue('released', queueDomain, { scraperId: slotRequest.scraperId });
        
        if (result && result._scrapeStatus === 'degraded') {
          return {
            success: false,
            source: 'degraded',
            statusReason: result._statusReason,
            shouldRetry: result._shouldRetry,
            retryStrategy: result._retryStrategy,
            data: result
          };
        }
        
        return {
          success: !!result,
          source: 'fresh',
          data: result
        };
        
      } catch (error) {
        await ProfileQueueManager.releaseScrapingSlot(queueDomain, slotRequest.scraperId);
        loggingService.queue('error-released', queueDomain, { 
          scraperId: slotRequest.scraperId,
          error: error.message
        });
        throw error;
      }
      
    } catch (error) {
      loggingService.error(`Queue system error for ${queueDomain}: ${error.message}`, {
        url,
        userId
      }, sessionId);
      throw error;
    } finally {
      loggingService.clearSessionContext(sessionId);
    }
  }

  async executeScraping(url, sessionId, options = {}) {
    const startTime = Date.now();
    const domain = loggingService.extractDomain(url);
    
    loggingService.updateSessionContext(sessionId, { step: 'detection' });
    
    const sessionDictionaryData = await this.detectLanguageAndCreateDictionary(url, options);
    const detectedLanguage = sessionDictionaryData.language;
    const sessionDictionary = sessionDictionaryData.dictionary;
    
    loggingService.language('detected', detectedLanguage, {
      source: sessionDictionaryData.source,
      domain
    }, sessionId);
    
    let sessionData = {
      stepUsed: null,
      wasHeadless: false,
      startTime: startTime,
      endTime: null,
      success: false,
      contentText: '',
      errorMessage: null,
      jobsFound: 0,
      platform: null,
      cacheCreated: false,
      detectedLanguage: detectedLanguage
    };
    
    try {
      const existingProfile = await this.domainProfiler.getDomainProfile(url);
      const detectedPlatform = this.detectJobPlatform(url);
      
      if (existingProfile) {
        loggingService.updateSessionContext(sessionId, { step: existingProfile.step });
        loggingService.fastTrack(`Using existing profile: ${existingProfile.step}`, {
          successRate: existingProfile.successRate,
          domain
        }, sessionId);
        
        const fastTrackResult = await this.attemptFastTrack(url, existingProfile, options, sessionData, sessionId, sessionDictionary);
        if (fastTrackResult) {
          if (fastTrackResult._scrapeStatus === 'degraded') {
            loggingService.logSoftFail(
              new Error(`Fast-track degraded: ${fastTrackResult._statusReason}`),
              'degraded_cache',
              sessionId
            );
            return fastTrackResult;
          }
          return fastTrackResult;
        }
      }
      
      if (detectedPlatform) {
        loggingService.updateSessionContext(sessionId, { step: detectedPlatform.name });
        loggingService.platform(detectedPlatform.name, 'detected', { domain }, sessionId);
        options.detectedPlatform = detectedPlatform;
        sessionData.platform = detectedPlatform.name;
      }
      
      options.dictionary = sessionDictionary;
      options.detectedLanguage = detectedLanguage;
      
      loggingService.steps('full-process', 'starting', { domain }, sessionId);
      const result = await this.executeFullScraping(url, options, sessionData, sessionId);
      
      if (result) {
        if (result._scrapeStatus === 'degraded') {
          loggingService.logSoftFail(
            new Error(`Scraping degraded: ${result._statusReason}`),
            'degraded_result',
            sessionId
          );
          
          sessionData.success = false;
          sessionData.endTime = Date.now();
          sessionData.stepUsed = result.stepUsed || 'degraded';
          sessionData.errorMessage = `Degraded result: ${result._statusReason}`;
          sessionData.platform = result.detectedPlatform || detectedPlatform?.name;
          sessionData.isMinimumCache = true;
          
          if (!options.skipProfileUpdate) {
            await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
          }
          
          return result;
        }
        
        if (this.isScrapedDataValid(result, sessionDictionary)) {
          const duration = Date.now() - startTime;
          loggingService.win('Full scraping successful', {
            domain,
            duration,
            jobsFound: result.links?.length || 0
          }, sessionId);
          
          sessionData.success = true;
          sessionData.contentText = result.text || '';
          sessionData.jobsFound = result.links ? result.links.length : 0;
          sessionData.endTime = Date.now();
          sessionData.platform = result.detectedPlatform || detectedPlatform?.name;
          
          await this.handleSuccessfulResult(url, result, sessionData, detectedLanguage, options);
          return result;
        }
      }
      
      loggingService.error('All scraping methods failed', { domain }, sessionId);
      sessionData.errorMessage = 'All scraping methods failed';
      sessionData.endTime = Date.now();
      sessionData.stepUsed = 'all_failed';
      
      if (!options.skipProfileUpdate) {
        await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
      }
      
      return null;
      
    } catch (error) {
      loggingService.error(`Scraping execution failed: ${error.message}`, {
        domain,
        stackTrace: error.stack
      }, sessionId);
      
      sessionData.errorMessage = error.message;
      sessionData.endTime = Date.now();
      sessionData.stepUsed = sessionData.stepUsed || 'error';
      
      if (!options.skipProfileUpdate) {
        await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
      }
      
      throw error;
    }
  }

  async executeFullScraping(url, options, sessionData, sessionId) {
    const maxRetries = options.maxRetries || 3;
    const domain = loggingService.extractDomain(url);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          loggingService.updateSessionContext(sessionId, { attempt });
          loggingService.retry('StepBasedScraper retry', attempt, maxRetries, {
            domain
          }, sessionId);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
        
        loggingService.updateSessionContext(sessionId, { step: 'stepbased' });
        loggingService.steps('stepbased', 'starting', { domain, attempt }, sessionId);
        
        const stepResult = await this.stepBasedScraper.scrape(url, {
          ...options,
          skipProfiling: false
        });
        
        if (stepResult && stepResult._scrapeStatus === 'degraded') {
          loggingService.logSoftFail(
            new Error(`StepBasedScraper degraded: ${stepResult._statusReason}`),
            'fallback_scraper',
            sessionId
          );
          
          sessionData.stepUsed = stepResult.method || 'StepBasedScraper-degraded';
          sessionData.wasHeadless = true;
          
          return stepResult;
        }
        
        if (stepResult && this.isScrapedDataValid(stepResult, options.dictionary)) {
          loggingService.steps('stepbased', 'successful', {
            domain,
            attempt,
            jobsFound: stepResult.links?.length || 0
          }, sessionId);
          
          sessionData.stepUsed = stepResult.method || 'StepBasedScraper';
          sessionData.wasHeadless = true;
          
          return stepResult;
        }
        
        loggingService.logSoftFail(
          new Error(`StepBasedScraper returned invalid data (attempt ${attempt})`),
          attempt < maxRetries ? 'retry' : 'fallback_scraper',
          sessionId
        );
        
      } catch (error) {
        loggingService.logSoftFail(
          new Error(`StepBasedScraper failed (attempt ${attempt}): ${error.message}`),
          attempt < maxRetries ? 'retry' : 'fallback_scraper',
          sessionId
        );
        sessionData.errorMessage = error.message;
        
        if (attempt === maxRetries) {
          break;
        }
      }
    }
    
    loggingService.retry('All StepBasedScraper attempts failed → trying fallback scrapers', maxRetries, maxRetries, {
      domain
    }, sessionId);
    
    try {
      if (this.shouldUseRobustScraper(url) || this.shouldUseSpecializedScraper(url)) {
        loggingService.updateSessionContext(sessionId, { step: 'robust-scraper' });
        loggingService.steps('robust-scraper', 'starting', { domain }, sessionId);
        sessionData.stepUsed = 'RobustScraper';
        sessionData.wasHeadless = true;
        
        const robustResult = await this.robustScraper.scrapeCareerPage(url, options);
        
        if (robustResult && robustResult._scrapeStatus === 'degraded') {
          loggingService.logSoftFail(
            new Error(`RobustScraper degraded: ${robustResult._statusReason}`),
            'degraded_result',
            sessionId
          );
          return robustResult;
        }
        
        if (robustResult && this.isScrapedDataValid(robustResult, options.dictionary)) {
          loggingService.win('RobustScraper successful → StepBasedScraper soft fail resolved', {
            domain,
            jobsFound: robustResult.links?.length || 0
          }, sessionId);
          sessionData.success = true;
          sessionData.contentText = robustResult.text || '';
          sessionData.jobsFound = robustResult.links ? robustResult.links.length : 0;
          sessionData.endTime = Date.now();
          
          return robustResult;
        }
      } else {
        loggingService.updateSessionContext(sessionId, { step: 'adaptive-scraper' });
        loggingService.steps('adaptive-scraper', 'starting', { domain }, sessionId);
        sessionData.stepUsed = 'axios-simple';
        sessionData.wasHeadless = false;
        
        const adaptiveResult = await this.adaptiveScraper.scrape(url, options);
        
        if (adaptiveResult && adaptiveResult._scrapeStatus === 'degraded') {
          loggingService.logSoftFail(
            new Error(`AdaptiveScraper degraded: ${adaptiveResult._statusReason}`),
            'degraded_result',
            sessionId
          );
          return adaptiveResult;
        }
        
        if (adaptiveResult && this.isScrapedDataValid(adaptiveResult, options.dictionary)) {
          loggingService.win('AdaptiveScraper successful → StepBasedScraper soft fail resolved', {
            domain,
            jobsFound: adaptiveResult.links?.length || 0
          }, sessionId);
          
          sessionData.stepUsed = adaptiveResult.method || 'axios-simple';
          sessionData.success = true;
          sessionData.contentText = adaptiveResult.text || '';
          sessionData.jobsFound = adaptiveResult.links ? adaptiveResult.links.length : 0;
          sessionData.endTime = Date.now();
          sessionData.platform = adaptiveResult.platform || adaptiveResult.detectedPlatform;
          
          return adaptiveResult;
        }
      }
    } catch (error) {
      loggingService.error(`Fallback scrapers failed: ${error.message}`, {
        domain,
        stackTrace: error.stack
      }, sessionId);
      sessionData.errorMessage = `Fallback error: ${error.message}`;
    }
    
    return null;
  }
  
  async attemptFastTrack(url, profile, options, sessionData, sessionId, sessionDictionary) {
    if (!profile.step || profile.successRate < 70 || profile.needsReprofiling) {
      return null;
    }
    
    const domain = loggingService.extractDomain(url);
    
    if (this.adaptiveMethodMap[profile.step]) {
      const methodName = this.adaptiveMethodMap[profile.step];
      const method = this.adaptiveScraper[methodName];
      
      if (method) {
        loggingService.fastTrack(`Using proven step ${profile.step}`, {
          successRate: profile.successRate,
          domain
        }, sessionId);
        
        try {
          sessionData.stepUsed = profile.step;
          sessionData.wasHeadless = profile.step.includes('playwright');
          
          const result = await method.call(this.adaptiveScraper, url);
          
          if (result && result._scrapeStatus === 'degraded') {
            loggingService.logSoftFail(
              new Error(`Fast-track returned degraded result: ${result._statusReason}`),
              'degraded_fasttrack',
              sessionId
            );
            return result;
          }
          
          if (result && this.isScrapedDataValid(result, sessionDictionary)) {
            loggingService.fastTrack(`${profile.step} successful via fast-track`, {
              domain,
              jobsFound: result.links?.length || 0
            }, sessionId);
            
            sessionData.success = true;
            sessionData.contentText = result.text || '';
            sessionData.jobsFound = result.links ? result.links.length : 0;
            sessionData.endTime = Date.now();
            sessionData.platform = result.platform || result.detectedPlatform;
            
            await this.handleSuccessfulResult(url, result, sessionData, profile.language, options);
            
            if (!options.skipProfileUpdate) {
              loggingService.domainProfile(domain, 'session-recorded', {
                language: profile.language,
                success: true
              });
              await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, profile.language);
            }
            
            loggingService.fastTrack(`FAST-TRACK SUCCESS: ${profile.step} succeeded, skipping all other scrapers`, {
              domain
            }, sessionId);
            return result;
          }
          
          loggingService.logSoftFail(
            new Error(`${profile.step} fast-track returned invalid data`),
            'fallback_full_process',
            sessionId
          );
          
        } catch (error) {
          loggingService.logSoftFail(
            new Error(`${profile.step} fast-track failed: ${error.message}`),
            'fallback_full_process',
            sessionId
          );
        }
      }
    }
    
    if (profile.preferredStep === 'robust-scraper' && profile.successRate >= 70) {
      try {
        loggingService.fastTrack('Using robust scraper directly based on profile', {
          domain,
          successRate: profile.successRate
        }, sessionId);
        
        sessionData.stepUsed = 'robust-scraper';
        sessionData.wasHeadless = true;
        
        const result = await this.robustScraper.scrapeCareerPage(url, options);
        
        if (result && result._scrapeStatus === 'degraded') {
          loggingService.logSoftFail(
            new Error(`Robust scraper returned degraded result: ${result._statusReason}`),
            'degraded_fasttrack',
            sessionId
          );
          return result;
        }
        
        if (result && this.isScrapedDataValid(result, sessionDictionary)) {
          loggingService.fastTrack('Robust scraper successful via profile', {
            domain,
            jobsFound: result.links?.length || 0
          }, sessionId);
          
          sessionData.success = true;
          sessionData.contentText = result.text || '';
          sessionData.jobsFound = result.links ? result.links.length : 0;
          sessionData.endTime = Date.now();
          
          await this.handleSuccessfulResult(url, result, sessionData, profile.language, options);
          
          if (!options.skipProfileUpdate) {
            await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, profile.language);
          }
          
          return result;
        }
      } catch (error) {
        loggingService.logSoftFail(
          new Error(`Preferred step failed: ${error.message}`),
          'fallback_full_process',
          sessionId
        );
      }
    }
    
    return null;
  }

  async handleSuccessfulResult(url, result, sessionData, detectedLanguage, options) {
    const domain = loggingService.extractDomain(url);
    
    try {
      if (options.saveCache !== false) {
        const saveSuccess = await saveCache(url, result);
        sessionData.cacheCreated = saveSuccess;
        if (saveSuccess) {
          loggingService.cache('created', domain, {
            jobsFound: result.links?.length || 0,
            textLength: result.text?.length || 0
          });
        }
      }
    } catch (error) {
      loggingService.error(`Cache save error for ${domain}: ${error.message}`, {
        url
      });
      sessionData.cacheCreated = false;
    }
  }

  handleQueuedRequest(slotRequest, url, sessionId) {
    const domain = loggingService.extractDomain(url);
    
    if (slotRequest.reason === 'queued' || slotRequest.reason === 'cooldown') {
      return {
        success: false,
        source: 'queued',
        error: `Request queued: ${slotRequest.waitTime}s wait time`,
        data: null
      };
    } else if (slotRequest.reason === 'buffered') {
      return this.handleBufferedRequest(url, slotRequest, sessionId);
    }
    
    return {
      success: false,
      source: 'rejected',
      error: slotRequest.reason,
      data: null
    };
  }

  async handleBufferedRequest(url, slotRequest, sessionId) {
    const domain = loggingService.extractDomain(url);
    
    try {
      const cachedData = await getCachedData(url, { fallbackOnError: true });
      if (cachedData) {
        const isMinimumCache = cachedData._cacheMetadata?.isMinimumCache === true;
        
        if (isMinimumCache) {
          loggingService.cache('minimum-while-buffered', domain, {
            position: slotRequest.queuePosition
          });
          return {
            success: false,
            source: 'cache-buffered-degraded',
            statusReason: 'minimum_cache_while_buffered',
            shouldRetry: true,
            retryStrategy: 'wait_for_fresh_scraping',
            data: cachedData
          };
        }
        
        loggingService.cache('hit-while-buffered', domain, {
          position: slotRequest.queuePosition
        });
        return {
          success: true,
          source: 'cache-buffered',
          data: cachedData
        };
      }
    } catch (error) {
      loggingService.error(`Cache error during buffering for ${domain}: ${error.message}`, {
        url
      }, sessionId);
    }
    
    return {
      success: false,
      source: 'buffered',
      error: `Request buffered, position ${slotRequest.queuePosition}`,
      data: null
    };
  }

  async detectLanguageAndCreateDictionary(url, options = {}) {
    try {
      loggingService.language('detection-start', 'unknown', { url });
      
      let finalLanguage = null;
      let detectionSource = 'fallback';
      
      if (options.context?.detectedLanguage && options.context.detectedLanguage !== 'unknown') {
        finalLanguage = options.context.detectedLanguage;
        detectionSource = 'context';
        loggingService.language('using-context', finalLanguage);
      } else if (options.providedLanguage && options.providedLanguage !== 'unknown') {
        finalLanguage = options.providedLanguage;
        detectionSource = 'provided';
        loggingService.language('using-provided', finalLanguage);
      } else {
        const existingProfile = await this.domainProfiler.getDomainProfile(url);
        if (existingProfile && existingProfile.language && existingProfile.language !== 'en') {
          finalLanguage = existingProfile.language;
          detectionSource = 'profile';
          loggingService.language('using-profile', finalLanguage);
        } else {
          try {
            const detectedRaw = await IndependentLanguageDetector.detectLanguageIndependent(url);
            finalLanguage = IndependentLanguageDetector.getScrapingLanguage(detectedRaw);
            detectionSource = 'detection';
            loggingService.language('detected-raw', finalLanguage, {
              rawResult: detectedRaw
            });
            
            if (finalLanguage && finalLanguage !== 'en') {
              try {
                await this.domainProfiler.loadCurrentProfiles();
                const domain = this.domainProfiler.getDomainFromUrl(url);
                const profile = this.domainProfiler.currentProfiles.get(domain) || 
                                this.domainProfiler.createNewProfile(domain, url, finalLanguage);
                
                profile.language = finalLanguage;
                profile.lastSeen = new Date().toISOString();
                
                this.domainProfiler.currentProfiles.set(domain, profile);
                
                try {
                  ProfileQueueManager.queueProfileUpdate(domain, profile);
                } catch (queueError) {
                  setTimeout(async () => {
                    await this.domainProfiler.saveCurrentProfiles();
                  }, 100);
                }
                
                loggingService.domainProfile(domain, 'language-saved', {
                  language: finalLanguage
                });
              } catch (error) {
                loggingService.error(`Failed to save language to profile: ${error.message}`, {
                  domain: this.domainProfiler.getDomainFromUrl(url),
                  language: finalLanguage
                });
              }
            }
          } catch (error) {
            loggingService.error(`Language detection failed: ${error.message}`, { url });
            finalLanguage = 'en';
            detectionSource = 'fallback';
          }
        }
      }
      
      const sessionLanguage = finalLanguage || 'en';
      const sessionDictionary = dictionariesManager.getDictionaryForLanguage(sessionLanguage);
      
      loggingService.language('session-finalized', sessionLanguage, {
        source: detectionSource
      });
      
      return {
        language: sessionLanguage,
        dictionary: sessionDictionary,
        source: detectionSource
      };
    } catch (error) {
      loggingService.error(`Dictionary creation failed: ${error.message}`, { url });
      return {
        language: 'en',
        dictionary: dictionariesManager.getDefaultDictionary(),
        source: 'error_fallback'
      };
    }
  }

  detectJobPlatform(url) {
    const lowerUrl = url.toLowerCase();
    
    for (const platform of this.knownJobPlatforms) {
      if (platform.patterns.some(pattern => lowerUrl.includes(pattern.toLowerCase()))) {
        return {
          name: platform.name,
          iframeMethod: platform.iframeMethod,
          directMethod: platform.directMethod,
          apiPatterns: platform.apiPatterns,
          indicators: platform.indicators
        };
      }
    }
    
    return null;
  }

  shouldUseRobustScraper(url) {
    const lowerUrl = url.toLowerCase();
    return this.complexDomains.some(domain => lowerUrl.includes(domain.toLowerCase()));
  }

  shouldUseSpecializedScraper(url) {
    const platform = this.detectJobPlatform(url);
    return platform && (platform.iframeMethod || platform.apiPatterns?.length > 0);
  }

  isScrapedDataValid(data, sessionDictionary = null) {
    if (!data) return false;
    if (!data.url || !data.scrapedAt) return false;
    if (!data.text || data.text.length < 50) return false;
    
    if (data._scrapeStatus === 'degraded') {
      loggingService.error(`Data marked as degraded: ${data._statusReason}`);
      return false;
    }
    
    if (data._cacheMetadata?.isMinimumCache === true || data.isMinimumCache === true) {
      loggingService.error('Data is minimum cache - not valid for success');
      return false;
    }
    
    if (data._cacheQuality === CACHE_QUALITY_TYPES.MINIMUM) {
      loggingService.error('Data has minimum quality - not valid for success');
      return false;
    }
    
    const textLower = data.text.toLowerCase();
    const hasBlockedWords = textLower.includes('access denied') || 
                            textLower.includes('forbidden') ||
                            textLower.includes('captcha');
    
    if (hasBlockedWords) {
      const hasValidJobs = data.links && Array.isArray(data.links) && data.links.length > 0;
      const hasJobContent = this.hasJobContent(data.text, sessionDictionary);
      
      if (hasValidJobs && hasJobContent) {
        loggingService.win(`Blocked words found but overridden due to valid jobs`, {
          jobsFound: data.links.length
        });
      } else {
        loggingService.error('Blocked words found and no valid jobs - rejecting');
        return false;
      }
    }
    
    const hasJobContentResult = this.hasJobContent(data.text, sessionDictionary);
    
    if (!hasJobContentResult) {
      const lowerUrl = data.url.toLowerCase();
      const urlHasJobTerms = lowerUrl.includes('career') || lowerUrl.includes('job') || 
          lowerUrl.includes('emploi') || lowerUrl.includes('stelle') ||
          lowerUrl.includes('lavoro') || lowerUrl.includes('empleo') ||
          lowerUrl.includes('recrute') || lowerUrl.includes('offres');
      
      if (!urlHasJobTerms) {
        return false;
      }
    }
    
    if (!data.links || !Array.isArray(data.links)) {
      data.links = [];
    }
    
    return true;
  }

  hasJobContent(text, sessionDictionary = null) {
    if (!text || text.length < 50) return false;
    
    const lowerText = text.toLowerCase();
    
    let jobTerms;
    if (sessionDictionary) {
      jobTerms = sessionDictionary.getJobTerms();
    } else {
      const defaultDictionary = dictionariesManager.getDefaultDictionary();
      jobTerms = defaultDictionary.getJobTerms();
    }
    
    const jobTermCount = jobTerms.filter(term => 
      lowerText.includes(term.toLowerCase())
    ).length;
    
    if (jobTermCount >= 1) return true;
    
    const careerKeywords = ['position', 'role', 'opportunity', 'apply', 'candidate', 'recruitment', 'hiring', 'team', 'company', 'join us', 'work with us'];
    const careerMatches = careerKeywords.filter(keyword => lowerText.includes(keyword)).length;
    
    if (careerMatches >= 2) return true;
    
    const contextKeywords = ['skills', 'experience', 'qualifications', 'requirements', 'responsibilities', 'benefits', 'salary', 'location'];
    const contextMatches = contextKeywords.filter(keyword => lowerText.includes(keyword)).length;
    
    return contextMatches >= 3;
  }

  extractHostnameForQueue(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      let cleanUrl = url.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
      return cleanUrl;
    }
  }

  extractDomainFromUrl(url) {
    try {
      const urlObj = new URL(url);
      let pathname = urlObj.pathname;
      if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      if (pathname === '') {
        pathname = '/';
      }
      return urlObj.hostname + pathname;
    } catch (error) {
      let cleanUrl = url.replace(/^https?:\/\//, '').split('?')[0];
      if (cleanUrl.endsWith('/')) {
        cleanUrl = cleanUrl.slice(0, -1);
      }
      return cleanUrl;
    }
  }

  async initialize() {
    try {
      if (this.initialized) {
        loggingService.buffer('ScrapingCoordinator already initialized');
        return true;
      }
      
      const startTime = Date.now();
      loggingService.buffer('ScrapingCoordinator initializing...');
      await this.ensureInitialized();
      await this.domainProfiler.loadCurrentProfiles();
      const duration = Date.now() - startTime;
      loggingService.timing('coordinator-initialization', duration);
      loggingService.buffer('ScrapingCoordinator initialized successfully');
      return true;
    } catch (error) {
      loggingService.error(`ScrapingCoordinator initialization failed: ${error.message}`);
      throw error;
    }
  }

  async getCoordinatorStats() {
    await this.ensureInitialized();
    try {
      const profileStats = await this.domainProfiler.getProfileStats();
      const queueStats = ProfileQueueManager.getQueueStats();
      
      return {
        profiles: profileStats,
        queue: queueStats,
        timestamp: new Date().toISOString(),
        coordinator: {
          initialized: this.initialized,
          adapters: ['stepBased', 'adaptive', 'robust'],
          supportedPlatforms: this.knownJobPlatforms.length
        }
      };
    } catch (error) {
      loggingService.error(`Error getting coordinator stats: ${error.message}`);
      return {
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async close() {
    try {
      await Promise.all([
        this.stepBasedScraper?.close?.().catch(e => loggingService.error(`Error closing StepBasedScraper: ${e.message}`)),
        this.robustScraper?.close?.().catch(e => loggingService.error(`Error closing RobustScraper: ${e.message}`))
      ]);
      this.initialized = false;
      loggingService.buffer('ScrapingCoordinator closed successfully');
    } catch (error) {
      loggingService.error(`Error closing scrapers: ${error.message}`);
    }
  }
}

ScrapingCoordinator.instance = null;

module.exports = ScrapingCoordinator;