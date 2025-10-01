const LightweightVariantsStep = require('./steps/LightweightVariantsStep');
const BambooHRStep = require('./steps/BambooHRStep');
const HeadlessRenderingStep = require('./steps/HeadlessRenderingStep');
const IframeAwareStep = require('./steps/IframeAwareStep');
const PowershiftStep = require('./steps/PowershiftStep');
const GreenhouseStep = require('./steps/GreenhouseStep');
const BrassringStep = require('./steps/BrassringStep');
const LeverStep = require('./steps/LeverStep');
const WorkdayStep = require('./steps/WorkdayStep');
const WorkableStep = require('./steps/WorkableStep');
const SmartRecruitersStep = require('./steps/SmartRecruitersStep');
const JazzHRStep = require('./steps/JazzHRStep');
const ADPStep = require('./steps/ADPStep');
const ZohoRecruitStep = require('./steps/ZohoRecruitStep');
const ZohoRecruitHeadlessStep = require('./steps/ZohoRecruitHeadlessStep');
const iCIMSStep = require('./steps/iCIMSStep');
const WordPressLightweightStep = require('./steps/WordPressLightweightStep');
const WordPressHeadlessStep = require('./steps/WordPressHeadlessStep');
const WordPressIframeStep = require('./steps/WordPressIframeStep');
const RecruiteeStep = require('./steps/RecruiteeStep');
const TeamTailorStep = require('./steps/TeamTailorStep');
const { getCachedData, saveCache, CACHE_QUALITY_TYPES } = require('../cacheManager');
const config = require('../config');
const scrapingMetrics = require('./scrapingMetricsService');
const platformDetector = require('./platformDetector');
const axios = require('axios');
const dictionariesManager = require('../dictionaries');
const DomainProfiler = require('./DomainProfiler');

class StepBasedScraper {
  constructor() {
    if (StepBasedScraper.instance) {
      return StepBasedScraper.instance;
    }
  
    this.steps = [
      new WordPressLightweightStep(),
      new LightweightVariantsStep(),
      new BambooHRStep(),
      new WordPressHeadlessStep(),
      new HeadlessRenderingStep(),
      new WordPressIframeStep(),
      new IframeAwareStep(),
      new RecruiteeStep(),
      new PowershiftStep(),
      new GreenhouseStep(),
      new LeverStep(),
      new WorkableStep(),
      new SmartRecruitersStep(),
      new JazzHRStep(),
      new ZohoRecruitStep(),
      new ZohoRecruitHeadlessStep(),
      new WorkdayStep(),
      new BrassringStep(),
      new ADPStep(),
      new iCIMSStep(),
      new TeamTailorStep()
    ];
    
    this.steps.sort((a, b) => a.priority - b.priority);
    
    this.domainIntelligence = new Map();
    this.failurePatterns = new Map();
    this.successPatterns = new Map();
    this.domainProfiler = DomainProfiler.getInstance();
    this.MAX_DOMAIN_INTELLIGENCE = 1000;
    
    this.adaptiveConfig = {
      maxRetries: 1,
      adaptiveTimeout: true,
      intelligentStepSelection: true,
      learningEnabled: true,
      globalTimeout: 60000
    };
  
    this.ADAPTIVE_SCRAPER_METHODS = {
      'axios-simple': 'scrapeWithAxios',
      'playwright-basic': 'scrapeWithPlaywright',
      'playwright-enhanced': 'scrapeWithPlaywrightEnhanced'
    };
  
    StepBasedScraper.instance = this;
  }
  
  cleanupOldestDomain() {
    if (this.domainIntelligence.size >= this.MAX_DOMAIN_INTELLIGENCE) {
      const oldestDomain = this.domainIntelligence.keys().next().value;
      this.domainIntelligence.delete(oldestDomain);
      this.failurePatterns.delete(oldestDomain);
      this.successPatterns.delete(oldestDomain);
      
      config.smartLog('domain-profile', `Cleaned oldest domain intelligence: ${oldestDomain} (total: ${this.domainIntelligence.size})`);
    }
  }
  
  injectDictionaryToStep(step, language, dictionary) {
    try {
      if (typeof step.setDictionary === 'function') {
        step.setDictionary(dictionary);
        config.smartLog('langue', `Dictionary injected for step ${step.name}: ${language}`);
      }
    } catch (error) {
      config.smartLog('fail', `Dictionary injection failed for step ${step.name}: ${error.message}`);
    }
  }
  
  async detectAndPrepareDictionary(url, htmlContent = null, options = {}) {
    try {
      let providedLanguage = options.detectedLanguage || options.context?.detectedLanguage;
      
      if (!providedLanguage || providedLanguage === 'unknown') {
        providedLanguage = null;
      }
      
      let dictionaryManagerInstance;
      
      if (providedLanguage) {
        dictionaryManagerInstance = dictionariesManager.getDictionaryForLanguage(providedLanguage);
      } else if (htmlContent) {
        dictionaryManagerInstance = await dictionariesManager.getDictionary(null);
      } else {
        dictionaryManagerInstance = dictionariesManager.getDefaultDictionary();
      }
      
      const detectedLanguage = dictionaryManagerInstance.getCurrentLanguage();
      
      config.smartLog('langue', `Session dictionary created for ${url}: ${detectedLanguage}`);
      
      return {
        language: detectedLanguage,
        dictionary: dictionaryManagerInstance
      };
    } catch (error) {
      config.smartLog('fail', `Dictionary preparation failed for ${url}: ${error.message}`);
      
      const fallbackDictionary = dictionariesManager.getDefaultDictionary();
      const fallbackLanguage = fallbackDictionary.getCurrentLanguage();
      
      return {
        language: fallbackLanguage,
        dictionary: fallbackDictionary
      };
    }
  }
  
  validateSelector(selector) {
    if (!selector || typeof selector !== 'string') return false;
    
    const openBrackets = (selector.match(/\[/g) || []).length;
    const closeBrackets = (selector.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) return false;
    
    if (selector.includes('[*]') || selector.includes('[data-*]')) return false;
    
    return true;
  }
  
  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting scrape for ${url}`);
    
    const overallStartTime = Date.now();
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Global timeout reached (60s)')), this.adaptiveConfig.globalTimeout);
    });
    
    try {
      const result = await Promise.race([
        this.performScrape(url, options, overallStartTime),
        timeoutPromise
      ]);
      
      return result;
    } catch (error) {
      if (error.message.includes('Global timeout')) {
        config.smartLog('timeout', `Global timeout reached for ${url}`);
        await scrapingMetrics.recordStepError(url, 'global', 'GlobalTimeout', error.message, overallStartTime);
      }
      throw error;
    }
  }

  async fetchHTMLForDetection(url) {
    const timeout = 10000;
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    
    for (let attempt = 0; attempt < userAgents.length; attempt++) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': userAgents[attempt],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          },
          timeout: timeout,
          maxRedirects: 3,
          validateStatus: (status) => status < 500
        });
        
        if (response.status === 200 && response.data && response.data.length > 500) {
          config.smartLog('steps', `HTML fetched successfully for detection (${response.data.length} chars)`);
          return response.data;
        }
        
        if (response.status === 403 || response.status === 429) {
          config.smartLog('retry', `HTTP ${response.status} received, trying different User-Agent`);
          continue;
        }
        
      } catch (error) {
        config.smartLog('retry', `Attempt ${attempt + 1} failed: ${error.message}`);
        if (attempt === userAgents.length - 1) {
          throw error;
        }
      }
    }
    
    throw new Error('All HTML fetch attempts failed');
  }
  
  async performScrape(url, options, overallStartTime) {
    try {
      const cachedData = await getCachedData(url);
      if (cachedData) {
        const cacheQuality = cachedData._cacheMetadata?.quality || 'unknown';
        const isMinimumCache = cachedData._cacheMetadata?.isMinimumCache === true;
        
        config.smartLog('cache', `Cache hit for ${url} (quality: ${cacheQuality})`);
        
        if (isMinimumCache || cacheQuality === CACHE_QUALITY_TYPES.MINIMUM) {
          config.smartLog('cache', `MINIMUM cache detected - returning degraded status for ${url}`);
          
          await scrapingMetrics.recordCacheHit(url);
          await scrapingMetrics.recordStepAttempt(url, 'cache-minimum', overallStartTime);
          await scrapingMetrics.recordStepSuccess(url, 'cache-minimum', overallStartTime, {
            textLength: cachedData.text ? cachedData.text.length : 0,
            linksCount: cachedData.links ? cachedData.links.length : 0,
            detectedPlatform: cachedData.detectedPlatform || null,
            cacheQuality: cacheQuality,
            degraded: true
          });
          
          return {
            ...cachedData,
            _scrapeStatus: 'degraded',
            _statusReason: 'minimum_cache_served',
            _shouldRetry: true,
            _retryStrategy: 'alternative_steps'
          };
        }
        
        await scrapingMetrics.recordCacheHit(url);
        await scrapingMetrics.recordStepAttempt(url, 'cache', overallStartTime);
        await scrapingMetrics.recordStepSuccess(url, 'cache', overallStartTime, {
          textLength: cachedData.text ? cachedData.text.length : 0,
          linksCount: cachedData.links ? cachedData.links.length : 0,
          detectedPlatform: cachedData.detectedPlatform || null
        });
        
        return cachedData;
      }
      
      await scrapingMetrics.recordCacheMiss(url);
    } catch (error) {
      config.smartLog('fail', `Cache error: ${error.message}`);
      await scrapingMetrics.recordStepError(url, 'cache', 'CacheError', error.message, overallStartTime);
    }
    
    const profileCheck = await this.domainProfiler.shouldUseCachedProfile(url);
    
    if (profileCheck.useProfile && profileCheck.step && profileCheck.successRate >= 70 && !profileCheck.needsReprofiling) {
      config.smartLog('fast-track', `Using proven step ${profileCheck.step} (${profileCheck.successRate.toFixed(1)}% success)`);
      
      if (this.ADAPTIVE_SCRAPER_METHODS[profileCheck.step]) {
        config.smartLog('fast-track', `EXECUTION - Step: ${profileCheck.step}, Language: ${profileCheck.language}, Platform: ${profileCheck.platform}`);
        
        try {
          const AdaptiveScraper = require('./adaptiveScraper');
          const adaptiveScraper = AdaptiveScraper.getInstance();
          
          const methodName = this.ADAPTIVE_SCRAPER_METHODS[profileCheck.step];
          const method = adaptiveScraper[methodName];
          
          if (method) {
            const { startTime: stepStartTime } = await scrapingMetrics.recordStepAttempt(url, profileCheck.step);
            
            const adaptiveResult = await method.call(adaptiveScraper, url);
            
            if (adaptiveResult && this.isResultValid(adaptiveResult, profileCheck.platform)) {
              config.smartLog('win', `FAST-TRACK SUCCESS - Jobs found: ${this.extractJobCount(adaptiveResult)}`);
              
              await scrapingMetrics.recordStepSuccess(url, profileCheck.step, stepStartTime, {
                textLength: adaptiveResult.text ? adaptiveResult.text.length : 0,
                linksCount: adaptiveResult.links ? adaptiveResult.links.length : 0,
                detectedPlatform: profileCheck.platform,
                jobTermsFound: this.countJobTerms(adaptiveResult.text, profileCheck.language),
                jobLinksFound: this.countJobLinks(adaptiveResult.links, profileCheck.language),
                fastTrack: true
              });
              
              const sessionData = {
                stepUsed: profileCheck.step,
                wasHeadless: profileCheck.step.includes('playwright'),
                startTime: overallStartTime,
                endTime: Date.now(),
                success: true,
                contentText: adaptiveResult.text || '',
                jobsFound: this.extractJobCount(adaptiveResult),
                platform: profileCheck.platform,
                detectedLanguage: profileCheck.language,
                awsService: profileCheck.aws || 'lambda',
                fastTrack: true
              };
              
              try {
                const cacheSuccess = await saveCache(url, adaptiveResult);
                sessionData.cacheCreated = cacheSuccess;
                config.smartLog('cache', `Single scrape completed: success=true, jobs=${sessionData.jobsFound}, cache=${cacheSuccess}`);
              } catch (error) {
                config.smartLog('fail', `Fast-track cache error: ${error.message}`);
                sessionData.cacheCreated = false;
              }
              
              if (!options.skipProfiling) {
                await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, profileCheck.language);
              }
              
              const domain = this.extractDomain(url);
              this.recordStepSuccess(domain, profileCheck.step, adaptiveResult);
              this.updateDomainIntelligence(domain, adaptiveResult, true);
              
              adaptiveResult.detectedPlatform = profileCheck.platform;
              adaptiveResult.detectedLanguage = profileCheck.language;
              
              return adaptiveResult;
            } else {
              config.smartLog('fail', `FAST-TRACK FAILED - Falling back to normal execution`);
              await scrapingMetrics.recordStepError(url, profileCheck.step, 'FastTrackFailed', 'Fast-track execution failed', stepStartTime);
            }
          }
        } catch (error) {
          config.smartLog('fail', `FAST-TRACK ERROR: ${error.message}`);
        }
      } else {
        const preferredStep = this.steps.find(step => step.name === profileCheck.step);
        if (preferredStep) {
          const fastTrackResult = await this.executeFastTrack(url, preferredStep, profileCheck, options, overallStartTime);
          if (fastTrackResult) return fastTrackResult;
        }
      }
    }
    
    let htmlContent = '';
    let detectedPlatform = null;
    let sessionDictionaryData = null;
    
    if (profileCheck.useProfile) {
      config.smartLog('domain-profile', `Using cached profile data for ${url}`);
      detectedPlatform = profileCheck.platform;
      
      sessionDictionaryData = {
        language: profileCheck.language,
        dictionary: dictionariesManager.getDictionaryForLanguage(profileCheck.language)
      };
      
      options.detectedPlatform = detectedPlatform;
      options.cachedProfile = profileCheck.profile;
    } else {
      config.smartLog('domain-profile', `Profile check failed: ${profileCheck.reason}`);
      
      try {
        htmlContent = await this.fetchHTMLForDetection(url);
        detectedPlatform = platformDetector.detectPlatform(url, htmlContent);
        
        sessionDictionaryData = await this.detectAndPrepareDictionary(url, htmlContent, options);
        
        if (detectedPlatform) {
          config.smartLog('platform', `Platform detected: ${detectedPlatform}`);
          options.detectedPlatform = detectedPlatform;
          options.htmlContent = htmlContent;
        }
        
      } catch (error) {
        config.smartLog('retry', `Could not fetch HTML for platform detection: ${error.message}`);
        detectedPlatform = platformDetector.detectPlatform(url);
        
        sessionDictionaryData = await this.detectAndPrepareDictionary(url, null, options);
        
        if (detectedPlatform) {
          config.smartLog('platform', `Fallback platform detection: ${detectedPlatform}`);
          options.detectedPlatform = detectedPlatform;
        }
      }
    }
    
    const sessionDictionary = sessionDictionaryData.dictionary;
    const detectedLanguage = sessionDictionaryData.language;
    
    config.smartLog('langue', `Session language finalized: ${detectedLanguage}`);
    
    const jobListingSelectors = sessionDictionary.getJobListingSelectors();
    if (jobListingSelectors) {
      const originalCount = jobListingSelectors.length;
      const validSelectors = jobListingSelectors.filter(selector => this.validateSelector(selector));
      if (validSelectors.length < originalCount) {
        config.smartLog('steps', `Filtered out ${originalCount - validSelectors.length} invalid selectors`);
      }
    }
    
    const domain = this.extractDomain(url);
    const domainHistory = this.domainIntelligence.get(domain) || this.initializeDomainHistory(domain);
    
    let sessionData = {
      stepUsed: null,
      wasHeadless: false,
      startTime: overallStartTime,
      endTime: null,
      success: false,
      contentText: '',
      errorMessage: null,
      jobsFound: 0,
      platform: detectedPlatform,
      detectedLanguage: detectedLanguage
    };
    
    let filteredSteps;
    let executionPlan;
    
    if (profileCheck.useProfile && profileCheck.step) {
      config.smartLog('steps', `Optimized execution using profile step: ${profileCheck.step}`);
      const preferredStep = this.steps.find(step => step.name === profileCheck.step);
      if (preferredStep) {
        filteredSteps = [preferredStep, ...this.steps.filter(s => s.name !== profileCheck.step).slice(0, 2)];
      } else {
        filteredSteps = this.filterStepsByPlatformStrict(this.steps, detectedPlatform);
      }
    } else {
      filteredSteps = this.filterStepsByPlatformStrict(this.steps, detectedPlatform);
    }
    
    executionPlan = this.createIntelligentExecutionPlan(url, domainHistory, options, filteredSteps);
    
    config.smartLog('steps', `Execution plan (${filteredSteps.length}/${this.steps.length} steps): ${executionPlan.map(p => p.step.name).join(' -> ')}`);
    
    if (detectedPlatform) {
      const recommendedStep = platformDetector.getRecommendedStep(detectedPlatform);
      if (recommendedStep) {
        config.smartLog('platform', `Recommended step for ${detectedPlatform}: ${recommendedStep}`);
      }
    }
    
    let result = null;
    let stepContext = { 
      domain, 
      url, 
      options, 
      detectedPlatform, 
      htmlContent, 
      detectedLanguage,
      dictionary: sessionDictionary,
      searchQuery: options.searchQuery || (options.context && options.context.searchQuery)
    };
    let attemptCount = 0;
    const maxAttempts = this.adaptiveConfig.maxRetries;
    
    while (!result && attemptCount < maxAttempts) {
      attemptCount++;
      config.smartLog('retry', `Attempt ${attemptCount}/${maxAttempts}`);
      
      for (const planItem of executionPlan) {
        const step = planItem.step;
        const stepConfig = planItem.config;
        
        const { startTime: stepStartTime } = await scrapingMetrics.recordStepAttempt(url, step.name);
        
        try {
          this.injectDictionaryToStep(step, detectedLanguage, sessionDictionary);
          
          const isApplicable = await step.isApplicable(url, stepContext);
          
          if (!isApplicable) {
            config.smartLog('steps', `Step ${step.name} not applicable, skipping`);
            await scrapingMetrics.recordStepError(url, step.name, 'StepNotApplicable', 'Step not applicable', stepStartTime);
            continue;
          }
          
          config.smartLog('steps', `Executing step ${step.name} (applicable)`);
          
          const enhancedOptions = {
            ...options,
            ...stepConfig,
            context: stepContext,
            attempt: attemptCount,
            domainHistory,
            detectedPlatform,
            htmlContent,
            detectedLanguage,
            dictionary: sessionDictionary,
            previousStepResult: stepContext.previousStepResult
          };
          
          sessionData.wasHeadless = step.name.includes('headless') || step.name.includes('rendering') || 
                                   step.name.includes('workday') || step.name.includes('bamboohr') ||
                                   step.name.includes('workable') || step.name.includes('greenhouse');
          
          const stepResult = await this.executeStepWithIntelligence(step, url, enhancedOptions, stepStartTime);
          
          if (stepResult && this.isResultValid(stepResult, detectedPlatform)) {
            config.smartLog('win', `Step ${step.name} successful on attempt ${attemptCount}`);
            
            if (stepResult.detectedPlatform) {
              config.smartLog('platform', `Platform detected: ${stepResult.detectedPlatform}`);
            }
            
            await scrapingMetrics.recordStepSuccess(url, step.name, stepStartTime, {
              textLength: stepResult.text ? stepResult.text.length : 0,
              linksCount: stepResult.links ? stepResult.links.length : 0,
              detectedPlatform: stepResult.detectedPlatform || detectedPlatform,
              jobTermsFound: this.countJobTerms(stepResult.text, detectedLanguage),
              jobLinksFound: this.countJobLinks(stepResult.links, detectedLanguage)
            });
            
            sessionData.stepUsed = step.name;
            sessionData.success = true;
            sessionData.contentText = stepResult.text || '';
            sessionData.jobsFound = this.extractJobCount(stepResult);
            sessionData.platform = stepResult.detectedPlatform || detectedPlatform;
            sessionData.endTime = Date.now();
            sessionData.detectedLanguage = detectedLanguage;
            
            this.recordStepSuccess(domain, step.name, stepResult);
            result = stepResult;
            result.detectedPlatform = result.detectedPlatform || detectedPlatform;
            result.detectedLanguage = detectedLanguage;
            break;
          }
          
          if (stepResult) {
            config.smartLog('steps', `Step ${step.name} returned partial result`);
            stepContext = { ...stepContext, previousStepResult: stepResult };
            
            await scrapingMetrics.recordStepError(url, step.name, 'PartialResult', 'Partial result returned', stepStartTime);
          } else {
            config.smartLog('fail', `Step ${step.name} returned no result`);
            await scrapingMetrics.recordStepError(url, step.name, 'NoResult', 'No result returned', stepStartTime);
          }
          
          this.recordStepFailure(domain, step.name, stepResult);
          
        } catch (error) {
          config.smartLog('fail', `Step ${step.name} error: ${error.message}`);
          await scrapingMetrics.recordStepError(url, step.name, 'ExecutionError', error.message, stepStartTime);
          this.recordStepFailure(domain, step.name, null, error);
        }
      }
      
      if (!result && attemptCount < maxAttempts) {
        config.smartLog('retry', `Attempt ${attemptCount} failed, adjusting strategy`);
        stepContext = this.adjustContextForRetry(stepContext, attemptCount);
        
        const retryDelay = Math.min(1000 * attemptCount, 3000);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    if (result) {
      try {
        await this.domainProfiler.recordHit(url, 'scraping');
      } catch (error) {
        config.smartLog('fail', `Could not record scraping hit: ${error.message}`);
      }
      
      const success = await this.handleSuccessfulResult(url, result, sessionData, detectedLanguage, profileCheck, options, overallStartTime);
      if (success) {
        this.updateDomainIntelligence(domain, result, true);
      }
    } else {
      config.smartLog('fail', `All attempts failed for ${url}`);
      
      const minimumCache = this.createMinimumCache(url, domain);
      
      try {
        const cacheSuccess = await saveCache(url, minimumCache);
        config.smartLog('cache', `Minimum cache created for ${url}: ${cacheSuccess}`);
        
        sessionData.endTime = Date.now();
        sessionData.success = false;
        sessionData.errorMessage = 'All scraping attempts failed';
        sessionData.stepUsed = sessionData.stepUsed || 'failed-minimum-cache';
        sessionData.detectedLanguage = detectedLanguage;
        sessionData.platform = detectedPlatform;
        sessionData.awsService = profileCheck.aws || 'lambda';
        sessionData.cacheCreated = cacheSuccess;
        sessionData.jobsFound = 0;
        sessionData.isMinimumCache = true;
        
        if (!options.skipProfiling) {
          await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
        }
        
        this.updateDomainIntelligence(domain, minimumCache, false);
        
        return {
          ...minimumCache,
          _scrapeStatus: 'degraded',
          _statusReason: 'all_steps_failed_minimum_cache_created',
          _shouldRetry: true,
          _retryStrategy: 'background_rescraping'
        };
        
      } catch (error) {
        config.smartLog('fail', `Minimum cache creation failed: ${error.message}`);
        await scrapingMetrics.recordStepError(url, 'cache', 'MinimumCacheError', error.message, overallStartTime);
        
        sessionData.endTime = Date.now();
        sessionData.success = false;
        sessionData.errorMessage = 'All scraping attempts failed and cache creation failed';
        sessionData.stepUsed = 'failed-no-cache';
        sessionData.detectedLanguage = detectedLanguage;
        sessionData.platform = detectedPlatform;
        sessionData.awsService = profileCheck.aws || 'lambda';
        sessionData.cacheCreated = false;
        sessionData.jobsFound = 0;
        sessionData.isMinimumCache = true;
        
        if (!options.skipProfiling) {
          await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
        }
        
        this.updateDomainIntelligence(domain, null, false);
        
        return {
          _scrapeStatus: 'failed',
          _statusReason: 'all_steps_failed_no_cache_created',
          _shouldRetry: true,
          _retryStrategy: 'full_retry_later'
        };
      }
    }
        
    return result;
  }
  
  async executeFastTrack(url, step, profileData, options, overallStartTime) {
    config.smartLog('fast-track', `EXECUTION - Step: ${step.name}, Language: ${profileData.language}, Platform: ${profileData.platform}`);
    
    const domain = this.extractDomain(url);
    const domainHistory = this.domainIntelligence.get(domain) || this.initializeDomainHistory(domain);
    const { startTime: stepStartTime } = await scrapingMetrics.recordStepAttempt(url, step.name);
    
    try {
      const sessionDictionary = dictionariesManager.getDictionaryForLanguage(profileData.language);
      
      this.injectDictionaryToStep(step, profileData.language, sessionDictionary);
      
      const enhancedOptions = {
        ...options,
        timeout: profileData.avgTime ? profileData.avgTime * 1.2 : 30000,
        detectedPlatform: profileData.platform,
        detectedLanguage: profileData.language,
        dictionary: sessionDictionary,
        fastTrack: true,
        cachedProfile: profileData.profile,
        context: {
          domain,
          url,
          options,
          detectedPlatform: profileData.platform,
          detectedLanguage: profileData.language,
          dictionary: sessionDictionary,
          searchQuery: options.searchQuery || (options.context && options.context.searchQuery)
        }
      };
      
      const stepResult = await step.scrape(url, enhancedOptions);
      
      if (stepResult && this.isResultValid(stepResult, profileData.platform)) {
        config.smartLog('win', `FAST-TRACK SUCCESS - Jobs found: ${this.extractJobCount(stepResult)}`);
        
        await scrapingMetrics.recordStepSuccess(url, step.name, stepStartTime, {
          textLength: stepResult.text ? stepResult.text.length : 0,
          linksCount: stepResult.links ? stepResult.links.length : 0,
          detectedPlatform: profileData.platform,
          jobTermsFound: this.countJobTerms(stepResult.text, profileData.language),
          jobLinksFound: this.countJobLinks(stepResult.links, profileData.language),
          fastTrack: true
        });
        
        const sessionData = {
          stepUsed: step.name,
          wasHeadless: step.name.includes('headless') || step.name.includes('rendering'),
          startTime: overallStartTime,
          endTime: Date.now(),
          success: true,
          contentText: stepResult.text || '',
          jobsFound: this.extractJobCount(stepResult),
          platform: profileData.platform,
          detectedLanguage: profileData.language,
          awsService: profileData.aws || 'lambda',
          fastTrack: true
        };
        
        try {
          const cacheSuccess = await saveCache(url, stepResult);
          sessionData.cacheCreated = cacheSuccess;
        } catch (error) {
          config.smartLog('fail', `Fast-track cache error: ${error.message}`);
          sessionData.cacheCreated = false;
        }
        
        if (!options.skipProfiling) {
          await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, profileData.language);
        }
        
        this.recordStepSuccess(domain, step.name, stepResult);
        this.updateDomainIntelligence(domain, stepResult, true);
        
        stepResult.detectedPlatform = profileData.platform;
        stepResult.detectedLanguage = profileData.language;
        
        return stepResult;
      } else {
        config.smartLog('fail', `FAST-TRACK FAILED - Falling back to normal execution`);
        await scrapingMetrics.recordStepError(url, step.name, 'FastTrackFailed', 'Fast-track execution failed', stepStartTime);
        return null;
      }
      
    } catch (error) {
      config.smartLog('fail', `FAST-TRACK ERROR: ${error.message}`);
      await scrapingMetrics.recordStepError(url, step.name, 'FastTrackError', error.message, stepStartTime);
      return null;
    }
  }
  
  createMinimumCache(url, domain) {
    const urlObj = new URL(url);
    const domainName = urlObj.hostname.replace(/^www\./, '');
    
    return {
      url: url,
      title: `${domainName} - Career Page`,
      text: `Career opportunities at ${domainName}. Visit the original page for current openings and job listings.`,
      links: [{ 
        url: url, 
        text: `View ${domainName} Career Page`,
        linkType: 'career_page',
        isJobPosting: false 
      }],
      scrapedAt: new Date().toISOString(),
      method: 'minimum-fallback',
      winRate: 0,
      jobsFound: 0,
      isEmpty: true,
      isMinimumCache: true,
      _cacheQuality: CACHE_QUALITY_TYPES.MINIMUM,
      detectedPlatform: null,
      detectedLanguage: 'en'
    };
  }
  
  async handleSuccessfulResult(url, result, sessionData, detectedLanguage, profileCheck, options) {
    try {
      const cacheSuccess = await saveCache(url, result);
      config.smartLog('cache', `Result cached for ${url}: ${cacheSuccess}`);
      
      this.updateSessionData(sessionData, result, detectedLanguage, profileCheck, cacheSuccess, true);
      
      if (!options.skipProfiling) {
        await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
      }
      
      return true;
    } catch (error) {
      config.smartLog('fail', `Cache save error: ${error.message}`);
      await scrapingMetrics.recordStepError(url, 'cache', 'CacheSaveError', error.message, Date.now());
      
      this.updateSessionData(sessionData, result, detectedLanguage, profileCheck, false, true);
      
      if (!options.skipProfiling) {
        await this.domainProfiler.recordScrapingSessionWithProvidedLanguage(url, sessionData, detectedLanguage);
      }
      
      return false;
    }
  }
  
  updateSessionData(sessionData, result, detectedLanguage, profileCheck, cacheCreated, success) {
    sessionData.endTime = Date.now();
    sessionData.stepUsed = sessionData.stepUsed || result?.method || 'step-based-scraper';
    sessionData.success = success;
    sessionData.contentText = result?.text || '';
    sessionData.jobsFound = this.extractJobCount(result);
    sessionData.platform = result?.detectedPlatform || sessionData.platform;
    sessionData.cacheCreated = cacheCreated;
    sessionData.detectedLanguage = detectedLanguage;
    sessionData.awsService = profileCheck?.aws || 'lambda';
  }

  extractJobCount(result) {
    if (!result) return 0;
    
    let jobCount = 0;
    
    if (result.links && Array.isArray(result.links)) {
      jobCount = result.links.filter(link => this.isJobLink(link)).length;
      
      if (jobCount === 0) {
        jobCount = result.links.length;
      }
    }
    
    if (jobCount === 0 && result.text) {
      const sessionDictionary = dictionariesManager.getDefaultDictionary();
      const jobTermsFound = this.countJobTerms(result.text, null, sessionDictionary);
      if (jobTermsFound > 0) {
        const jobTerms = sessionDictionary.getJobTerms();
        const textLower = result.text.toLowerCase();
        
        for (const term of jobTerms) {
          const regex = new RegExp(term.toLowerCase(), 'gi');
          const matches = textLower.match(regex);
          if (matches) {
            jobCount += matches.length;
          }
        }
        
        jobCount = Math.min(jobCount, 200);
      }
    }
    
    return Math.max(jobCount, 0);
  }

  filterStepsByPlatformStrict(allSteps, detectedPlatform) {
    if (!detectedPlatform) {
      config.smartLog('platform', `No platform detected, using lightweight steps only`);
      return [
        ...allSteps.filter(step => step.name.includes('lightweight')),
        ...allSteps.filter(step => step.name.includes('headless')),
        ...allSteps.filter(step => step.name.includes('wordpress'))
      ].slice(0, 5);
    }
    
    config.smartLog('platform', `Platform detected: ${detectedPlatform}, STRICT filtering`);
    
    const platformStepMappings = {
      'Greenhouse': 'greenhouse-step',
      'Workable': 'workable-step',
      'BambooHR': 'bamboohr-step',
      'Lever': 'lever-step',
      'SmartRecruiters': 'smartrecruiters-step',
      'Smartrecruiters': 'smartrecruiters-step',
      'JazzHR': 'jazzhr-step',
      'iCIMS': 'icims-step',
      'ADP': 'adp-step',
      'Workday': 'workday-step',
      'ZohoRecruit': 'zoho-recruit-step',
      'Recruitee': 'recruitee-step',
      'Brassring': 'brassring-step',
      'BrassRing': 'brassring-step',
      'Powershift': 'powershift-step',
      'TeamTailor': 'teamtailor-step'
    };
    
    const expectedStepName = platformStepMappings[detectedPlatform];
    
    if (expectedStepName) {
      const platformStep = allSteps.find(step => step.name === expectedStepName);
      
      if (platformStep) {
        config.smartLog('platform', `STRICT MODE: Using ONLY ${platformStep.name} for ${detectedPlatform}`);
        
        const fallbackSteps = [];
        
        if (detectedPlatform === 'WordPress') {
          fallbackSteps.push(...allSteps.filter(step => 
            step.name.includes('wordpress') && step.name !== expectedStepName
          ).slice(0, 2));
        } else {
          fallbackSteps.push(...allSteps.filter(step => 
            ['headless-rendering', 'iframe-aware-rendering'].includes(step.name)
          ).slice(0, 1));
        }
        
        return [platformStep, ...fallbackSteps];
      } else {
        config.smartLog('platform', `Expected step ${expectedStepName} not found for platform ${detectedPlatform}`);
      }
    }
    
    if (detectedPlatform === 'WordPress') {
      config.smartLog('platform', `WordPress detected, using ONLY WordPress steps`);
      const wordpressSteps = allSteps.filter(step => 
        step.name.includes('wordpress')
      );
      
      if (wordpressSteps.length > 0) {
        return wordpressSteps;
      }
    }
    
    config.smartLog('platform', `Unknown platform ${detectedPlatform}, using minimal generic steps`);
    return [
      ...allSteps.filter(step => step.name.includes('lightweight')),
      ...allSteps.filter(step => step.name.includes('headless'))
    ].slice(0, 3);
  }
  
  detectJobPlatform(url) {
    const urlLower = url.toLowerCase();
    const sessionDictionary = dictionariesManager.getDefaultDictionary();
    const knownJobPlatforms = sessionDictionary.getKnownJobPlatforms();
    
    for (const platform of knownJobPlatforms) {
      for (const pattern of platform.patterns) {
        if (urlLower.includes(pattern.toLowerCase())) {
          return platform.name;
        }
      }
    }
    
    return platformDetector.detectPlatform(url);
  }
  
  isComplexDomain(url) {
    const urlLower = url.toLowerCase();
    const sessionDictionary = dictionariesManager.getDefaultDictionary();
    const complexDomains = sessionDictionary.getComplexDomains();
    return complexDomains.some(domain => urlLower.includes(domain));
  }
  
  countJobTerms(text, language = null, customDictionary = null) {
    if (!text) return 0;
    const textLower = text.toLowerCase();
    
    let jobTerms;
    if (customDictionary) {
      jobTerms = customDictionary.getJobTerms();
    } else if (language) {
      const langDictionary = dictionariesManager.getDictionaryForLanguage(language);
      jobTerms = langDictionary.getJobTerms();
    } else {
      const defaultDictionary = dictionariesManager.getDefaultDictionary();
      jobTerms = defaultDictionary.getJobTerms();
    }
    
    return jobTerms.filter(term => textLower.includes(term.toLowerCase())).length;
  }
  
  countJobLinks(links, language = null) {
    if (!links) return 0;
    return links.filter(link => this.isJobLink(link, language)).length;
  }
  
  isJobLink(link, language = null) {
    if (!link) return false;
    
    const url = link.href || link.url || '';
    const text = link.text || link.title || '';
    
    let jobURLPatterns, jobTerms;
    if (language) {
      const langDictionary = dictionariesManager.getDictionaryForLanguage(language);
      jobURLPatterns = langDictionary.getJobURLPatterns();
      jobTerms = langDictionary.getJobTerms();
    } else {
      const defaultDictionary = dictionariesManager.getDefaultDictionary();
      jobURLPatterns = defaultDictionary.getJobURLPatterns();
      jobTerms = defaultDictionary.getJobTerms();
    }
    
    if (jobURLPatterns.some(pattern => pattern.test(url))) {
      return true;
    }
    
    const textLower = text.toLowerCase();
    return jobTerms.some(term => textLower.includes(term.toLowerCase()));
  }
  
  isResultValid(result, detectedPlatform = null) {
    if (!result) return false;
    
    const sessionDictionary = dictionariesManager.getDefaultDictionary();
    const hasMinimumContent = result.text && result.text.length > 100;
    const hasJobTerms = this.countJobTerms(result.text, null, sessionDictionary) > 0;
    const hasJobLinks = this.countJobLinks(result.links) > 0;
    const hasLinks = result.links && result.links.length > 0;
    
    const hasUnrenderedTemplates = this.hasUnrenderedTemplates(result.text);
    
    if (hasUnrenderedTemplates) {
      config.smartLog('fail', `Result contains unrendered templates, invalid`);
      return false;
    }
    
    const resultPlatform = result.detectedPlatform || detectedPlatform;
    
    if (resultPlatform) {
      config.smartLog('platform', `Platform detected (${resultPlatform}), relaxed validation`);
      const isValid = hasMinimumContent;
      if (!isValid) {
        config.smartLog('fail', `Platform result validation failed - Content: ${hasMinimumContent}`);
      } else {
        config.smartLog('win', `Platform result VALID - Content: ${hasMinimumContent}, JobTerms: ${hasJobTerms}, Links: ${hasLinks}`);
      }
      return isValid;
    }
    
    const isValid = hasMinimumContent && (hasJobTerms || hasJobLinks || hasLinks);
    
    if (!isValid) {
      config.smartLog('fail', `Generic result validation failed - Content: ${hasMinimumContent}, JobTerms: ${hasJobTerms}, JobLinks: ${hasJobLinks}, Links: ${hasLinks}`);
    }
    
    return isValid;
  }
  
  hasUnrenderedTemplates(text) {
    if (!text) return false;
    
    const templatePatterns = [
      /\{\{\s*department\s*\}\}/i,
      /\{\{\s*job\.jobTitle\s*\}\}/i,
      /\{\{\s*job\.location\s*\}\}/i,
      /\{\{\s*[^}]+\}\}/,
      /\{%[^%]+%\}/,
      /<%[^%]+%>/,
      /\$\{[^}]+\}/
    ];
    
    return templatePatterns.some(pattern => pattern.test(text));
  }

  createIntelligentExecutionPlan(url, domainHistory, options, availableSteps = null) {
    const steps = availableSteps || this.steps;
    const domain = this.extractDomain(url);
    const plan = [];
    
    if (this.adaptiveConfig.intelligentStepSelection && domainHistory.successfulSteps.size > 0) {
      const sortedSteps = Array.from(domainHistory.successfulSteps.entries())
        .sort((a, b) => b[1].successRate - a[1].successRate)
        .map(([stepName]) => steps.find(s => s.name === stepName))
        .filter(Boolean);
      
      for (const step of sortedSteps) {
        const stepHistory = domainHistory.successfulSteps.get(step.name);
        const config = this.generateStepConfig(step, stepHistory, options, url);
        plan.push({ step, config });
      }
      
      const remainingSteps = steps.filter(step => 
        !sortedSteps.some(s => s.name === step.name)
      );
      
      for (const step of remainingSteps) {
        const config = this.generateStepConfig(step, null, options, url);
        plan.push({ step, config });
      }
    } else {
      for (const step of steps) {
        const config = this.generateStepConfig(step, null, options, url);
        plan.push({ step, config });
      }
    }
    
    return plan;
  }
  
  generateStepConfig(step, stepHistory, options, url) {
    const sessionDictionary = dictionariesManager.getDefaultDictionary();
    
    const baseConfig = {
      timeout: this.calculateAdaptiveTimeout(step, stepHistory),
      retryCount: stepHistory ? Math.min(stepHistory.avgRetries + 1, 2) : 1,
      specialPlatform: options.specialPlatform || null,
      detectedPlatform: options.detectedPlatform || null,
      jobSelectors: sessionDictionary.getJobListingSelectors(),
      showMoreSelectors: sessionDictionary.getShowMoreSelectors(),
      paginationSelectors: sessionDictionary.getPaginationSelectors(),
      navigationSelectors: sessionDictionary.getJobNavigationSelectors(),
      buttonPatterns: sessionDictionary.getButtonPatterns()
    };
    
    const knownJobPlatforms = sessionDictionary.getKnownJobPlatforms();
    
    if (step.name === 'headless-rendering') {
      baseConfig.maxClicks = stepHistory ? Math.min(stepHistory.avgClicks + 5, 30) : 20;
      baseConfig.scrollStrategy = stepHistory?.bestScrollStrategy || 'adaptive';
      baseConfig.buttonDetectionLevel = stepHistory ? 'advanced' : 'standard';
      baseConfig.maxScrollTime = this.isComplexDomain(url) ? 20000 : 15000;
      baseConfig.maxButtonTime = this.isComplexDomain(url) ? 25000 : 20000;
      baseConfig.aggressiveMode = this.isComplexDomain(url);
    }
    
    if (step.name === 'iframe-aware-rendering') {
      baseConfig.frameTimeout = stepHistory ? stepHistory.avgFrameTime + 1000 : 5000;
      baseConfig.maxFrameDepth = 2;
      baseConfig.platformSpecific = options.detectedPlatform ? 
        knownJobPlatforms.find(p => p.name === options.detectedPlatform) : null;
    }
    
    if (step.name === 'lightweight-variants') {
      baseConfig.jobTerms = sessionDictionary.getJobTerms();
      baseConfig.jobPatterns = sessionDictionary.getJobURLPatterns();
    }
    
    if (step.name.includes('wordpress')) {
      baseConfig.wordPressSpecific = true;
      baseConfig.maxPaginationPages = stepHistory ? Math.min(stepHistory.avgPages + 2, 10) : 5;
      baseConfig.maxShowMoreClicks = stepHistory ? Math.min(stepHistory.avgClicks + 3, 10) : 5;
      baseConfig.waitForContentTime = 3000;
      baseConfig.jobExtractionMode = 'comprehensive';
    }
    
    if (step.name === 'bamboohr-step') {
      baseConfig.waitTime = stepHistory ? stepHistory.avgWaitTime + 2000 : 8000;
      baseConfig.maxWaitTime = 15000;
      baseConfig.bambooHRSpecific = true;
      baseConfig.platformConfig = knownJobPlatforms.find(p => p.name === 'BambooHR');
    }
    
    if (step.name === 'workable-step') {
      baseConfig.maxLoadMoreAttempts = stepHistory ? Math.min(stepHistory.avgLoadMore + 5, 20) : 15;
      baseConfig.workableSpecific = true;
      baseConfig.platformConfig = knownJobPlatforms.find(p => p.name === 'Workable');
      baseConfig.waitForContentTime = 2000;
      baseConfig.jobExtractionMode = 'comprehensive';
    }
    
    if (step.name === 'icims-step') {
      baseConfig.maxApiAttempts = stepHistory ? Math.min(stepHistory.avgApiAttempts + 2, 5) : 3;
      baseConfig.icimsSpecific = true;
      baseConfig.platformConfig = knownJobPlatforms.find(p => p.name === 'iCIMS');
      baseConfig.apiTimeout = stepHistory ? stepHistory.avgApiTime + 2000 : 12000;
      baseConfig.directScrapingFallback = true;
      baseConfig.headlessFallback = true;
    }
    
    if (step.name === 'jazzhr-step') {
      baseConfig.maxApiAttempts = stepHistory ? Math.min(stepHistory.avgApiAttempts + 2, 6) : 4;
      baseConfig.jazzHRSpecific = true;
      baseConfig.platformConfig = knownJobPlatforms.find(p => p.name === 'JazzHR');
      baseConfig.widgetTimeout = stepHistory ? stepHistory.avgWidgetTime + 1000 : 8000;
      baseConfig.apiTimeout = stepHistory ? stepHistory.avgApiTime + 2000 : 10000;
      baseConfig.directScrapingFallback = true;
    }

    return baseConfig;
  }
  
  calculateAdaptiveTimeout(step, stepHistory) {
    if (!this.adaptiveConfig.adaptiveTimeout) {
      return step.defaultTimeout || 20000;
    }
    
    const baseTimeout = step.defaultTimeout || 20000;
    
    if (stepHistory) {
      const avgTime = stepHistory.avgExecutionTime || baseTimeout;
      return Math.min(Math.max(avgTime * 1.2, baseTimeout), 40000);
    }
    
    return baseTimeout;
  }
  
  async executeStepWithIntelligence(step, url, options, startTime) {
    const stepName = step.name;
    const domain = this.extractDomain(url);
    const remainingTime = this.adaptiveConfig.globalTimeout - (Date.now() - startTime);
    
    if (remainingTime < 5000) {
      throw new Error('Insufficient time remaining for step execution');
    }
    
    options.timeout = Math.min(options.timeout || 30000, remainingTime - 2000);
    
    try {
      const result = await step.scrape(url, options);
      
      if (result && step.isResultValid && step.isResultValid(result)) {
        const executionTime = Date.now() - startTime;
        this.recordStepPerformance(domain, stepName, executionTime, result);
        config.smartLog('win', `Step ${stepName} returned valid result`);
        return result;
      } else if (result) {
        config.smartLog('fail', `Step ${stepName} returned invalid result, continuing to next step`);
        const executionTime = Date.now() - startTime;
        this.recordStepError(domain, stepName, executionTime, new Error('Invalid result'));
        return null;
      } else {
        config.smartLog('fail', `Step ${stepName} returned no result`);
        return null;
      }
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.recordStepError(domain, stepName, executionTime, error);
      throw error;
    }
  }
  
  recordStepSuccess(domain, stepName, result) {
    const domainHistory = this.domainIntelligence.get(domain);
    
    if (!domainHistory.successfulSteps.has(stepName)) {
      domainHistory.successfulSteps.set(stepName, {
        successCount: 0,
        totalAttempts: 0,
        avgExecutionTime: 0,
        avgTextLength: 0,
        avgLinksCount: 0,
        avgJobTerms: 0,
        avgJobLinks: 0,
        successRate: 0,
        detectedPlatforms: new Map()
      });
    }
    
    const stepStats = domainHistory.successfulSteps.get(stepName);
    stepStats.successCount++;
    stepStats.totalAttempts++;
    stepStats.avgTextLength = (stepStats.avgTextLength + (result.text?.length || 0)) / 2;
    stepStats.avgLinksCount = (stepStats.avgLinksCount + (result.links?.length || 0)) / 2;
    stepStats.avgJobTerms = (stepStats.avgJobTerms + this.countJobTerms(result.text)) / 2;
    stepStats.avgJobLinks = (stepStats.avgJobLinks + this.countJobLinks(result.links)) / 2;
    stepStats.successRate = (stepStats.successCount / stepStats.totalAttempts) * 100;
    
    if (result.detectedPlatform) {
      const platformCount = stepStats.detectedPlatforms.get(result.detectedPlatform) || 0;
      stepStats.detectedPlatforms.set(result.detectedPlatform, platformCount + 1);
    }
    
    domainHistory.lastSuccessfulStep = stepName;
    domainHistory.lastSuccess = Date.now();
    
    if (this.adaptiveConfig.learningEnabled) {
      this.updateSuccessPatterns(domain, stepName, result);
    }
  }
  
  recordStepFailure(domain, stepName, partialResult, error = null) {
    const domainHistory = this.domainIntelligence.get(domain);
    
    if (!domainHistory.failedSteps.has(stepName)) {
      domainHistory.failedSteps.set(stepName, {
        failureCount: 0,
        totalAttempts: 0,
        commonErrors: new Map(),
        failureRate: 0
      });
    }
    
    const stepStats = domainHistory.failedSteps.get(stepName);
    stepStats.failureCount++;
    stepStats.totalAttempts++;
    stepStats.failureRate = (stepStats.failureCount / stepStats.totalAttempts) * 100;
    
    if (error) {
      const errorType = error.name || 'UnknownError';
      const errorCount = stepStats.commonErrors.get(errorType) || 0;
      stepStats.commonErrors.set(errorType, errorCount + 1);
    }
    
    if (this.adaptiveConfig.learningEnabled) {
      this.updateFailurePatterns(domain, stepName, error);
    }
  }
  
  recordStepPerformance(domain, stepName, executionTime, result) {
    const domainHistory = this.domainIntelligence.get(domain);
    
    if (domainHistory.successfulSteps.has(stepName)) {
      const stepStats = domainHistory.successfulSteps.get(stepName);
      stepStats.avgExecutionTime = (stepStats.avgExecutionTime + executionTime) / 2;
    }
    
    domainHistory.performanceMetrics.set(stepName, {
      lastExecutionTime: executionTime,
      avgExecutionTime: domainHistory.performanceMetrics.get(stepName)?.avgExecutionTime || executionTime,
      quality: this.calculateResultQuality(result),
      detectedPlatform: result.detectedPlatform || null,
      jobTermsFound: this.countJobTerms(result.text),
      jobLinksFound: this.countJobLinks(result.links)
    });
  }
  
  recordStepError(domain, stepName, executionTime, error) {
    const domainHistory = this.domainIntelligence.get(domain);
    
    if (!domainHistory.errorMetrics.has(stepName)) {
      domainHistory.errorMetrics.set(stepName, {
        errorCount: 0,
        totalTime: 0,
        avgErrorTime: 0,
        lastError: null
      });
    }
    
    const errorStats = domainHistory.errorMetrics.get(stepName);
    errorStats.errorCount++;
    errorStats.totalTime += executionTime;
    errorStats.avgErrorTime = errorStats.totalTime / errorStats.errorCount;
    errorStats.lastError = {
      message: error.message,
      time: Date.now()
    };
  }
  
  calculateResultQuality(result) {
    if (!result) return 0;
    
    let quality = 0;
    
    if (result.text) {
      quality += Math.min(result.text.length / 1000, 5);
      
      const jobTermsCount = this.countJobTerms(result.text);
      quality += Math.min(jobTermsCount / 5, 3);
    }
    
    if (result.links) {
      quality += Math.min(result.links.length / 10, 2);
      
      const jobLinksCount = this.countJobLinks(result.links);
      quality += Math.min(jobLinksCount / 3, 3);
    }
    
    if (result.detectedPlatform) {
      quality += 2;
    }
    
    return Math.min(quality, 10);
  }
  
  updateSuccessPatterns(domain, stepName, result) {
    const pattern = {
      domain,
      stepName,
      textLength: result.text?.length || 0,
      linksCount: result.links?.length || 0,
      jobTermsCount: this.countJobTerms(result.text),
      jobLinksCount: this.countJobLinks(result.links),
      hasJobLinks: result.links?.some(link => this.isJobLink(link)) || false,
      method: result.method,
      detectedPlatform: result.detectedPlatform || null,
      timestamp: Date.now()
    };
    
    const domainPatterns = this.successPatterns.get(domain) || [];
    domainPatterns.push(pattern);
    
    if (domainPatterns.length > 10) {
      domainPatterns.shift();
    }
    
    this.successPatterns.set(domain, domainPatterns);
  }
  
  updateFailurePatterns(domain, stepName, error) {
    const pattern = {
      domain,
      stepName,
      errorType: error?.name || 'UnknownError',
      errorMessage: error?.message || 'Unknown error',
      timestamp: Date.now()
    };
    
    const domainPatterns = this.failurePatterns.get(domain) || [];
    domainPatterns.push(pattern);
    
    if (domainPatterns.length > 10) {
      domainPatterns.shift();
    }
    
    this.failurePatterns.set(domain, domainPatterns);
  }
  
  adjustContextForRetry(context, attemptNumber) {
    return {
      ...context,
      retryAttempt: attemptNumber,
      moreAggressive: attemptNumber > 1,
      extendedTimeout: false,
      enableFallbacks: attemptNumber > 1,
      useAlternativeSelectors: attemptNumber > 1,
      forceDeepScraping: attemptNumber === this.adaptiveConfig.maxRetries
    };
  }
  
  updateDomainIntelligence(domain, result, success) {
    const domainHistory = this.domainIntelligence.get(domain);
    
    domainHistory.totalAttempts++;
    
    if (success) {
      domainHistory.successCount++;
      domainHistory.lastSuccessTime = Date.now();
      
      if (result) {
        domainHistory.avgQuality = (domainHistory.avgQuality + this.calculateResultQuality(result)) / 2;
        
        if (result.detectedPlatform) {
          domainHistory.detectedPlatform = result.detectedPlatform;
        }
        
        domainHistory.avgJobTerms = (domainHistory.avgJobTerms || 0 + this.countJobTerms(result.text)) / 2;
        domainHistory.avgJobLinks = (domainHistory.avgJobLinks || 0 + this.countJobLinks(result.links)) / 2;
      }
    } else {
      domainHistory.failureCount++;
      domainHistory.lastFailureTime = Date.now();
    }
    
    domainHistory.successRate = (domainHistory.successCount / domainHistory.totalAttempts) * 100;
    
    if (domainHistory.totalAttempts % 5 === 0) {
      config.smartLog('domain-profile', `Domain ${domain} stats - Success Rate: ${domainHistory.successRate.toFixed(1)}%, Quality: ${domainHistory.avgQuality.toFixed(1)}, Platform: ${domainHistory.detectedPlatform || 'None'}, Job Terms: ${(domainHistory.avgJobTerms || 0).toFixed(1)}, Job Links: ${(domainHistory.avgJobLinks || 0).toFixed(1)}`);
    }
  }
  
  initializeDomainHistory(domain) {
    this.cleanupOldestDomain();
    
    const history = {
      domain,
      totalAttempts: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      avgQuality: 0,
      avgJobTerms: 0,
      avgJobLinks: 0,
      lastSuccessTime: null,
      lastFailureTime: null,
      lastSuccessfulStep: null,
      successfulSteps: new Map(),
      failedSteps: new Map(),
      performanceMetrics: new Map(),
      errorMetrics: new Map(),
      detectedPlatform: null,
      createdAt: Date.now()
    };
    
    this.domainIntelligence.set(domain, history);
    return history;
  }
  
  extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch (error) {
      return url;
    }
  }
  
  getDomainIntelligence(domain) {
    return this.domainIntelligence.get(domain) || null;
  }
  
  getSuccessPatterns(domain) {
    return this.successPatterns.get(domain) || [];
  }
  
  getFailurePatterns(domain) {
    return this.failurePatterns.get(domain) || [];
  }
  
  resetDomainIntelligence(domain) {
    this.domainIntelligence.delete(domain);
    this.successPatterns.delete(domain);
    this.failurePatterns.delete(domain);
    config.smartLog('domain-profile', `Intelligence reset for domain: ${domain}`);
  }
  
  exportIntelligence() {
    return {
      domainIntelligence: Array.from(this.domainIntelligence.entries()).map(([domain, history]) => ({
        domain,
        ...history,
        successfulSteps: Array.from(history.successfulSteps.entries()),
        failedSteps: Array.from(history.failedSteps.entries()),
        performanceMetrics: Array.from(history.performanceMetrics.entries()),
        errorMetrics: Array.from(history.errorMetrics.entries())
      })),
      successPatterns: Array.from(this.successPatterns.entries()),
      failurePatterns: Array.from(this.failurePatterns.entries())
    };
  }
  
  importIntelligence(data) {
    if (data.domainIntelligence) {
      for (const domainData of data.domainIntelligence) {
        const { domain, ...history } = domainData;
        history.successfulSteps = new Map(history.successfulSteps);
        history.failedSteps = new Map(history.failedSteps);
        history.performanceMetrics = new Map(history.performanceMetrics);
        history.errorMetrics = new Map(history.errorMetrics);
        this.domainIntelligence.set(domain, history);
      }
    }
    
    if (data.successPatterns) {
      this.successPatterns = new Map(data.successPatterns);
    }
    
    if (data.failurePatterns) {
      this.failurePatterns = new Map(data.failurePatterns);
    }
    
    config.smartLog('domain-profile', `Intelligence imported for ${this.domainIntelligence.size} domains`);
  }
  
  async close() {
    for (const step of this.steps) {
      if (typeof step.close === 'function') {
        try {
          await step.close();
        } catch (error) {
          config.smartLog('fail', `Error closing step ${step.name}: ${error.message}`);
        }
      }
    }
    
    config.smartLog('steps', `Closed with intelligence for ${this.domainIntelligence.size} domains`);
  }

  static getInstance() {
    if (!StepBasedScraper.instance) {
      StepBasedScraper.instance = new StepBasedScraper();
    }
    return StepBasedScraper.instance;
  }
}

StepBasedScraper.instance = null;

module.exports = StepBasedScraper;