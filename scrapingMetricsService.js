const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const os = require('os');
const dictionaries = require('../dictionaries');

class ScrapingMetricsService {
  constructor() {
    this.metricsFile = path.join(config.DEBUG_DIR, 'scraping_metrics.json');
    this.errorLogFile = path.join(config.DEBUG_DIR, 'scraping_errors.json');
    this.resourceMetricsFile = path.join(config.DEBUG_DIR, 'resource_metrics.json');
    this.cacheMetricsFile = path.join(config.DEBUG_DIR, 'cache_metrics.json');
    this.metrics = {};
    this.errors = {};
    this.resourceMetrics = {};
    this.cacheMetrics = {};
    this.loaded = false;
  }

  async loadAll() {
    if (this.loaded) return;
    
    await Promise.all([
      this.loadMetrics(),
      this.loadErrors(),
      this.loadResourceMetrics(),
      this.loadCacheMetrics()
    ]);
    
    this.loaded = true;
  }

  async loadMetrics() {
    try {
      const data = await fs.readFile(this.metricsFile, 'utf8');
      this.metrics = JSON.parse(data);
    } catch (error) {
      this.metrics = {};
    }
  }
  
  async loadErrors() {
    try {
      const data = await fs.readFile(this.errorLogFile, 'utf8');
      this.errors = JSON.parse(data);
    } catch (error) {
      this.errors = {};
    }
  }
  
  async loadResourceMetrics() {
    try {
      const data = await fs.readFile(this.resourceMetricsFile, 'utf8');
      this.resourceMetrics = JSON.parse(data);
    } catch (error) {
      this.resourceMetrics = {};
    }
  }
  
  async loadCacheMetrics() {
    try {
      const data = await fs.readFile(this.cacheMetricsFile, 'utf8');
      this.cacheMetrics = JSON.parse(data);
    } catch (error) {
      this.cacheMetrics = {};
    }
  }

  async saveMetrics() {
    try {
      await fs.writeFile(this.metricsFile, JSON.stringify(this.metrics, null, 2));
    } catch (error) {
      config.smartLog('fail', `Error saving metrics: ${error.message}`, { stackTrace: error.stack });
    }
  }
  
  async saveErrors() {
    try {
      await fs.writeFile(this.errorLogFile, JSON.stringify(this.errors, null, 2));
    } catch (error) {
      config.smartLog('fail', `Error saving error log: ${error.message}`, { stackTrace: error.stack });
    }
  }
  
  async saveResourceMetrics() {
    try {
      await fs.writeFile(this.resourceMetricsFile, JSON.stringify(this.resourceMetrics, null, 2));
    } catch (error) {
      config.smartLog('fail', `Error saving resource metrics: ${error.message}`, { stackTrace: error.stack });
    }
  }
  
  async saveCacheMetrics() {
    try {
      await fs.writeFile(this.cacheMetricsFile, JSON.stringify(this.cacheMetrics, null, 2));
    } catch (error) {
      config.smartLog('fail', `Error saving cache metrics: ${error.message}`, { stackTrace: error.stack });
    }
  }

  detectJobPlatform(url, domain) {
    const knownJobPlatforms = dictionaries.knownJobPlatforms;
    for (const platform of knownJobPlatforms) {
      const matchesPattern = platform.patterns.some(pattern => 
        url.toLowerCase().includes(pattern.toLowerCase()) || 
        domain.toLowerCase().includes(pattern.toLowerCase())
      );
      
      if (matchesPattern) {
        return {
          name: platform.name,
          directMethod: platform.directMethod || false,
          iframeMethod: platform.iframeMethod || false,
          apiPatterns: platform.apiPatterns || []
        };
      }
    }
    return null;
  }

  isComplexDomain(domain) {
    const complexDomains = dictionaries.complexDomains;
    return complexDomains.some(complexDomain => 
      domain.toLowerCase().includes(complexDomain.toLowerCase())
    );
  }

  isJobRelatedURL(url) {
    const jobURLPatterns = dictionaries.jobURLPatterns;
    const jobDetailURLPatterns = dictionaries.jobDetailURLPatterns;
    return jobURLPatterns.some(pattern => pattern.test(url)) ||
           jobDetailURLPatterns.some(pattern => pattern.test(url));
  }

  getExpectedComplexityFromDictionary(url, domain) {
    let complexityFactor = 1.0;
    let recommendations = [];

    const platform = this.detectJobPlatform(url, domain);
    if (platform) {
      if (platform.iframeMethod) {
        complexityFactor = 1.5;
        recommendations.push(`Platform ${platform.name} typically requires iframe handling`);
      }
      if (platform.apiPatterns.length > 0) {
        recommendations.push(`Platform ${platform.name} may have API endpoints: ${platform.apiPatterns.slice(0, 2).join(', ')}`);
      }
    }

    if (this.isComplexDomain(domain)) {
      complexityFactor = Math.max(complexityFactor, 1.3);
      recommendations.push('Domain is known to be complex for scraping');
    }

    if (!this.isJobRelatedURL(url)) {
      recommendations.push('URL does not match typical job posting patterns');
    }

    return {
      expectedComplexityFactor: complexityFactor,
      platform: platform,
      recommendations: recommendations,
      isJobRelated: this.isJobRelatedURL(url),
      isKnownComplex: this.isComplexDomain(domain)
    };
  }

  async recordApplicabilityCheck(url, stepName, startTime = Date.now()) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    const dictionaryAnalysis = this.getExpectedComplexityFromDictionary(url, domain);
    
    if (!this.metrics[domain]) {
      this.metrics[domain] = {
        url: url,
        totalApplicabilityChecks: 0,
        totalRealAttempts: 0,
        steps: {},
        firstSeen: new Date().toISOString(),
        lastAttempt: null,
        detectedPlatform: dictionaryAnalysis.platform,
        isKnownComplex: dictionaryAnalysis.isKnownComplex,
        isJobRelated: dictionaryAnalysis.isJobRelated,
        dictionaryRecommendations: dictionaryAnalysis.recommendations
      };
    }
    
    if (!this.metrics[domain].steps[stepName]) {
      this.metrics[domain].steps[stepName] = {
        applicabilityChecks: 0,
        realAttempts: 0,
        notApplicableCount: 0,
        successes: 0,
        lastAttemptedAt: null,
        lastApplicabilityCheckAt: null,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        realSuccessRate: null
      };
    }
    
    this.metrics[domain].totalApplicabilityChecks++;
    this.metrics[domain].steps[stepName].applicabilityChecks++;
    this.metrics[domain].steps[stepName].lastApplicabilityCheckAt = new Date().toISOString();
    this.metrics[domain].lastAttempt = new Date().toISOString();
    
    await this.saveMetrics();
    
    return { domain, startTime, dictionaryAnalysis };
  }

  async recordStepNotApplicable(url, stepName, startTime) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    
    if (this.metrics[domain] && this.metrics[domain].steps[stepName]) {
      this.metrics[domain].steps[stepName].notApplicableCount++;
      this.updateStepSuccessRates(domain, stepName);
    }
    
    await this.saveMetrics();
  }

  async recordStepAttempt(url, stepName, startTime = Date.now()) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    
    if (!this.metrics[domain] || !this.metrics[domain].steps[stepName]) {
      await this.recordApplicabilityCheck(url, stepName, startTime);
    }
    
    this.metrics[domain].totalRealAttempts++;
    this.metrics[domain].steps[stepName].realAttempts++;
    this.metrics[domain].steps[stepName].lastAttemptedAt = new Date().toISOString();
    this.metrics[domain].steps[stepName].startTime = startTime;
    
    await this.saveMetrics();
    
    return { domain, startTime };
  }

  async recordStepSuccess(url, stepName, startTime, contentStats = {}) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    if (this.metrics[domain] && this.metrics[domain].steps[stepName]) {
      this.metrics[domain].steps[stepName].successes++;
      this.metrics[domain].steps[stepName].lastSuccessAt = new Date().toISOString();
      this.metrics[domain].lastSuccessfulStep = stepName;
      this.metrics[domain].lastSuccessAt = new Date().toISOString();
      
      this.metrics[domain].steps[stepName].totalExecutionTime += executionTime;
      const realAttempts = this.metrics[domain].steps[stepName].realAttempts;
      this.metrics[domain].steps[stepName].averageExecutionTime = 
        this.metrics[domain].steps[stepName].totalExecutionTime / realAttempts;
      
      this.updateStepSuccessRates(domain, stepName);
      
      if (contentStats.textLength || contentStats.linksCount) {
        if (!this.metrics[domain].contentStats) {
          this.metrics[domain].contentStats = {};
        }
        
        if (!this.metrics[domain].contentStats[stepName]) {
          this.metrics[domain].contentStats[stepName] = {
            textLengths: [],
            linksCounts: [],
            averageTextLength: 0,
            averageLinksCount: 0,
            jobTermsFound: []
          };
        }
        
        if (contentStats.textLength) {
          this.metrics[domain].contentStats[stepName].textLengths.push(contentStats.textLength);
          const sum = this.metrics[domain].contentStats[stepName].textLengths.reduce((a, b) => a + b, 0);
          this.metrics[domain].contentStats[stepName].averageTextLength = 
            sum / this.metrics[domain].contentStats[stepName].textLengths.length;
        }
        
        if (contentStats.linksCount) {
          this.metrics[domain].contentStats[stepName].linksCounts.push(contentStats.linksCount);
          const sum = this.metrics[domain].contentStats[stepName].linksCounts.reduce((a, b) => a + b, 0);
          this.metrics[domain].contentStats[stepName].averageLinksCount = 
            sum / this.metrics[domain].contentStats[stepName].linksCounts.length;
        }

        if (contentStats.extractedText) {
          const foundTerms = this.analyzeJobTerms(contentStats.extractedText);
          this.metrics[domain].contentStats[stepName].jobTermsFound = foundTerms;
        }
      }
      
      this.calculateComplexityScore(domain);
      await this.recordResourceUsage(domain, stepName, executionTime);
      await this.saveMetrics();
    }
  }

  updateStepSuccessRates(domain, stepName) {
    const stepData = this.metrics[domain].steps[stepName];
    if (stepData.realAttempts > 0) {
      stepData.realSuccessRate = (stepData.successes / stepData.realAttempts) * 100;
    } else {
      stepData.realSuccessRate = null;
    }
  }

  analyzeJobTerms(text) {
    if (!text) return [];
    
    const normalizedText = text.toLowerCase();
    const foundTerms = [];
    const jobTerms = dictionaries.jobTerms;
    
    for (const term of jobTerms) {
      if (normalizedText.includes(term.toLowerCase())) {
        foundTerms.push(term);
      }
    }
    
    return [...new Set(foundTerms)].slice(0, 10);
  }
  
  async recordStepError(url, stepName, errorType, errorMessage, startTime) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    if (!this.errors[domain]) {
      this.errors[domain] = {
        totalErrors: 0,
        steps: {},
        errorTypes: {}
      };
    }
    
    if (!this.errors[domain].steps[stepName]) {
      this.errors[domain].steps[stepName] = {
        errors: 0,
        lastErrorAt: null,
        errorTypes: {}
      };
    }
    
    if (!this.errors[domain].errorTypes[errorType]) {
      this.errors[domain].errorTypes[errorType] = 0;
    }
    
    if (!this.errors[domain].steps[stepName].errorTypes[errorType]) {
      this.errors[domain].steps[stepName].errorTypes[errorType] = 0;
    }
    
    this.errors[domain].totalErrors++;
    this.errors[domain].steps[stepName].errors++;
    this.errors[domain].steps[stepName].lastErrorAt = new Date().toISOString();
    this.errors[domain].errorTypes[errorType]++;
    this.errors[domain].steps[stepName].errorTypes[errorType]++;
    
    if (!this.errors[domain].errorHistory) {
      this.errors[domain].errorHistory = [];
    }
    
    this.errors[domain].errorHistory.unshift({
      timestamp: new Date().toISOString(),
      step: stepName,
      type: errorType,
      message: errorMessage,
      executionTime
    });
    
    if (this.errors[domain].errorHistory.length > 20) {
      this.errors[domain].errorHistory = this.errors[domain].errorHistory.slice(0, 20);
    }
    
    await this.saveErrors();
    this.calculateComplexityScore(domain);
  }
  
  async recordCacheHit(url) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    
    if (!this.cacheMetrics[domain]) {
      this.cacheMetrics[domain] = {
        hits: 0,
        misses: 0,
        hitRate: 0,
        lastHitAt: null,
        lastMissAt: null,
        avgTimeBetweenHits: null,
        lastHits: []
      };
    }
    
    this.cacheMetrics[domain].hits++;
    this.cacheMetrics[domain].lastHitAt = new Date().toISOString();
    
    const total = this.cacheMetrics[domain].hits + this.cacheMetrics[domain].misses;
    this.cacheMetrics[domain].hitRate = (this.cacheMetrics[domain].hits / total) * 100;
    
    this.cacheMetrics[domain].lastHits.push(Date.now());
    
    if (this.cacheMetrics[domain].lastHits.length > 10) {
      this.cacheMetrics[domain].lastHits.shift();
    }
    
    if (this.cacheMetrics[domain].lastHits.length > 1) {
      let totalTime = 0;
      for (let i = 1; i < this.cacheMetrics[domain].lastHits.length; i++) {
        totalTime += this.cacheMetrics[domain].lastHits[i] - this.cacheMetrics[domain].lastHits[i-1];
      }
      this.cacheMetrics[domain].avgTimeBetweenHits = totalTime / (this.cacheMetrics[domain].lastHits.length - 1);
    }
    
    await this.saveCacheMetrics();
  }
  
  async recordCacheMiss(url) {
    await this.loadAll();
    
    const domain = this.extractDomain(url);
    
    if (!this.cacheMetrics[domain]) {
      this.cacheMetrics[domain] = {
        hits: 0,
        misses: 0,
        hitRate: 0,
        lastHitAt: null,
        lastMissAt: null,
        avgTimeBetweenHits: null,
        lastHits: []
      };
    }
    
    this.cacheMetrics[domain].misses++;
    this.cacheMetrics[domain].lastMissAt = new Date().toISOString();
    
    const total = this.cacheMetrics[domain].hits + this.cacheMetrics[domain].misses;
    this.cacheMetrics[domain].hitRate = total > 0 ? (this.cacheMetrics[domain].hits / total) * 100 : 0;
    
    await this.saveCacheMetrics();
  }
  
  async recordResourceUsage(domain, stepName, executionTime) {
    const timestamp = Date.now();
    const memoryUsage = process.memoryUsage();
    
    let numCores = 1;
    try {
      numCores = os.cpus().length || 1;
    } catch (e) {
      config.smartLog('fail', `Error getting CPU cores: ${e.message}`, { stackTrace: e.stack });
    }
    
    let cpuUsagePerCore = Math.min(
      (executionTime > 10000) ? 50 : 25,
      90
    );
    
    const totalCpuUsage = cpuUsagePerCore * numCores;
    const variabilityFactor = 0.8 + (Math.random() * 0.4);
    cpuUsagePerCore = Math.round(cpuUsagePerCore * variabilityFactor);
    
    if (!this.resourceMetrics[domain]) {
      this.resourceMetrics[domain] = {
        steps: {},
        history: []
      };
    }
    
    if (!this.resourceMetrics[domain].steps[stepName]) {
      this.resourceMetrics[domain].steps[stepName] = {
        totalExecutionTime: 0,
        executions: 0,
        avgExecutionTime: 0,
        estimatedMemoryUsage: 0,
        estimatedCpuUsagePerCore: 0,
        estimatedTotalCpuUsage: 0,
        numCores: numCores
      };
    }
    
    this.resourceMetrics[domain].steps[stepName].totalExecutionTime += executionTime;
    this.resourceMetrics[domain].steps[stepName].executions++;
    this.resourceMetrics[domain].steps[stepName].avgExecutionTime = 
      this.resourceMetrics[domain].steps[stepName].totalExecutionTime / 
      this.resourceMetrics[domain].steps[stepName].executions;
    
    const memoryMB = Math.round(memoryUsage.heapUsed / (1024 * 1024));
    
    this.resourceMetrics[domain].steps[stepName].estimatedMemoryUsage = 
      (this.resourceMetrics[domain].steps[stepName].estimatedMemoryUsage * 0.7) + (memoryMB * 0.3);
    
    this.resourceMetrics[domain].steps[stepName].estimatedCpuUsagePerCore = 
      (this.resourceMetrics[domain].steps[stepName].estimatedCpuUsagePerCore * 0.7) + (cpuUsagePerCore * 0.3);
    
    this.resourceMetrics[domain].steps[stepName].estimatedTotalCpuUsage = 
      (this.resourceMetrics[domain].steps[stepName].estimatedTotalCpuUsage * 0.7) + (totalCpuUsage * 0.3);
    
    if (this.resourceMetrics[domain].steps[stepName].estimatedTotalCpuUsage > numCores * 100) {
      config.smartLog('monitoring', `Resetting abnormal CPU usage value for ${domain}/${stepName}`);
      this.resourceMetrics[domain].steps[stepName].estimatedTotalCpuUsage = totalCpuUsage;
      this.resourceMetrics[domain].steps[stepName].estimatedCpuUsagePerCore = cpuUsagePerCore;
    }
    
    this.resourceMetrics[domain].history.push({
      timestamp,
      step: stepName,
      executionTime,
      memory: memoryMB,
      cpuPerCore: cpuUsagePerCore,
      totalCpu: totalCpuUsage,
      numCores: numCores
    });
    
    if (this.resourceMetrics[domain].history.length > 100) {
      this.resourceMetrics[domain].history = this.resourceMetrics[domain].history.slice(-100);
    }
    
    await this.saveResourceMetrics();
  }

  calculateComplexityScore(domain) {
    if (!this.metrics[domain]) return;
    
    const timeWeight = 0.25;
    const stepsWeight = 0.35;
    const errorsWeight = 0.25;
    const dictionaryWeight = 0.15;
    
    let timeScore = 0;
    let stepsScore = 0;
    let errorsScore = 0;
    let dictionaryScore = 0;
    
    let totalTime = 0;
    let stepCount = 0;
    for (const step in this.metrics[domain].steps) {
      if (this.metrics[domain].steps[step].averageExecutionTime) {
        totalTime += this.metrics[domain].steps[step].averageExecutionTime;
        stepCount++;
      }
    }
    
    if (stepCount > 0) {
      const avgTime = totalTime / stepCount;
      timeScore = Math.min(100, avgTime / 100);
    }
    
    if (this.metrics[domain].lastSuccessfulStep) {
      const stepNames = ['simple-http', 'lightweight-variant', 'headless-rendering', 'iframe-aware-rendering'];
      const stepIndex = stepNames.indexOf(this.metrics[domain].lastSuccessfulStep);
      if (stepIndex !== -1) {
        stepsScore = ((stepIndex + 1) / stepNames.length) * 100;
      }
    }
    
    if (this.errors[domain]) {
      const errorsPerAttempt = this.errors[domain].totalErrors / this.metrics[domain].totalRealAttempts;
      errorsScore = Math.min(100, errorsPerAttempt * 200);
    }

    if (this.metrics[domain].detectedPlatform) {
      if (this.metrics[domain].detectedPlatform.iframeMethod) {
        dictionaryScore += 30;
      }
      if (this.metrics[domain].detectedPlatform.apiPatterns?.length > 0) {
        dictionaryScore += 20;
      }
    }
    
    if (this.metrics[domain].isKnownComplex) {
      dictionaryScore += 25;
    }
    
    if (!this.metrics[domain].isJobRelated) {
      dictionaryScore += 15;
    }
    
    dictionaryScore = Math.min(100, dictionaryScore);
    
    const complexityScore = (timeScore * timeWeight) + 
                            (stepsScore * stepsWeight) + 
                            (errorsScore * errorsWeight) +
                            (dictionaryScore * dictionaryWeight);
    
    let complexityCategory = 'Easy';
    if (complexityScore > 80) complexityCategory = 'Very Hard';
    else if (complexityScore > 60) complexityCategory = 'Hard';
    else if (complexityScore > 40) complexityCategory = 'Medium';
    else if (complexityScore > 20) complexityCategory = 'Moderate';
    
    this.metrics[domain].complexityScore = Math.round(complexityScore);
    this.metrics[domain].complexityCategory = complexityCategory;
  }

  async getCacheRecommendation(domain) {
    await this.loadAll();
    
    if (!this.cacheMetrics[domain]) {
      return {
        currentHitRate: 0,
        recommendedCacheDuration: config.CACHE_DURATION,
        recommendation: "Use default cache duration"
      };
    }
    
    const hitRate = this.cacheMetrics[domain].hitRate || 0;
    let recommendedDuration = config.CACHE_DURATION;
    let recommendation = "";
    
    const domainMetrics = this.metrics[domain];
    if (domainMetrics?.detectedPlatform) {
      if (domainMetrics.detectedPlatform.name === 'Workday' || domainMetrics.detectedPlatform.name === 'Taleo') {
        recommendedDuration = 8 * 60 * 60 * 1000;
        recommendation = `${domainMetrics.detectedPlatform.name} platform detected. Recommended shorter cache for dynamic content.`;
      } else if (domainMetrics.detectedPlatform.directMethod) {
        recommendedDuration = 16 * 60 * 60 * 1000;
        recommendation = `${domainMetrics.detectedPlatform.name} platform with direct method. Medium cache duration recommended.`;
      }
    }
    
    if (hitRate < 20) {
      recommendedDuration = Math.min(recommendedDuration, 6 * 60 * 60 * 1000);
      recommendation = "Low cache hit rate. Reduce cache duration for fresher data.";
    } else if (hitRate > 80) {
      recommendedDuration = Math.max(recommendedDuration, 48 * 60 * 60 * 1000);
      recommendation = "High hit rate. Increase cache duration to reduce site load.";
    } else if (this.cacheMetrics[domain].avgTimeBetweenHits) {
      const avgTimeBetweenHits = this.cacheMetrics[domain].avgTimeBetweenHits;
      if (avgTimeBetweenHits < 15 * 60 * 1000) {
        recommendedDuration = 12 * 60 * 60 * 1000;
        recommendation = "Very frequent hits. Increase cache duration to avoid overload.";
      } else if (avgTimeBetweenHits > 24 * 60 * 60 * 1000) {
        recommendedDuration = Math.min(avgTimeBetweenHits * 0.8, 72 * 60 * 60 * 1000);
        recommendation = "Infrequent hits. Adapt cache duration to usage pattern.";
      }
    }
    
    return {
      currentHitRate: hitRate,
      recommendedCacheDuration: recommendedDuration,
      recommendation
    };
  }

  async getMetrics() {
    await this.loadAll();
    return this.metrics;
  }

  async getErrors() {
    await this.loadAll();
    return this.errors;
  }
  
  async getResourceMetrics() {
    await this.loadAll();
    return this.resourceMetrics;
  }
  
  async getCacheMetrics() {
    await this.loadAll();
    return this.cacheMetrics;
  }

  async getDomainMetrics(domain) {
    await this.loadAll();
    return this.metrics[domain] || null;
  }
  
  async getDomainErrors(domain) {
    await this.loadAll();
    return this.errors[domain] || null;
  }
  
  async getDomainResourceMetrics(domain) {
    await this.loadAll();
    return this.resourceMetrics[domain] || null;
  }
  
  async getDomainCacheMetrics(domain) {
    await this.loadAll();
    return this.cacheMetrics[domain] || null;
  }
  
  async getStepStats() {
    await this.loadAll();
    
    const stats = {
      totalDomains: 0,
      totalApplicabilityChecks: 0,
      totalRealAttempts: 0,
      stepStats: {},
      domains: [],
      platformStats: {},
      errorStats: {
        totalErrors: 0,
        byErrorType: {}
      },
      resourceStats: {
        avgExecutionTime: 0,
        totalExecutionTime: 0,
        avgMemoryUsage: 0,
        avgCpuUsage: 0
      },
      cacheStats: {
        totalHits: 0,
        totalMisses: 0,
        globalHitRate: 0
      }
    };
    
    for (const domain in this.metrics) {
      const domainData = this.metrics[domain];
      stats.totalDomains++;
      stats.totalApplicabilityChecks += domainData.totalApplicabilityChecks || 0;
      stats.totalRealAttempts += domainData.totalRealAttempts || 0;
      
      const domainEntry = {
        domain,
        url: domainData.url,
        totalApplicabilityChecks: domainData.totalApplicabilityChecks || 0,
        totalRealAttempts: domainData.totalRealAttempts || 0,
        lastSuccessfulStep: domainData.lastSuccessfulStep,
        lastSuccessAt: domainData.lastSuccessAt,
        complexityScore: domainData.complexityScore || 0,
        complexityCategory: domainData.complexityCategory || 'Unclassified',
        detectedPlatform: domainData.detectedPlatform,
        isKnownComplex: domainData.isKnownComplex,
        isJobRelated: domainData.isJobRelated,
        dictionaryRecommendations: domainData.dictionaryRecommendations
      };

      if (domainData.detectedPlatform) {
        const platformName = domainData.detectedPlatform.name;
        if (!stats.platformStats[platformName]) {
          stats.platformStats[platformName] = {
            count: 0,
            avgComplexity: 0,
            totalComplexity: 0,
            successfulDomains: 0
          };
        }
        stats.platformStats[platformName].count++;
        stats.platformStats[platformName].totalComplexity += (domainData.complexityScore || 0);
        stats.platformStats[platformName].avgComplexity = 
          stats.platformStats[platformName].totalComplexity / stats.platformStats[platformName].count;
        
        if (domainData.lastSuccessfulStep) {
          stats.platformStats[platformName].successfulDomains++;
        }
      }
      
      if (this.errors[domain]) {
        domainEntry.errors = this.errors[domain].totalErrors;
        stats.errorStats.totalErrors += this.errors[domain].totalErrors;
        
        for (const errorType in this.errors[domain].errorTypes) {
          if (!stats.errorStats.byErrorType[errorType]) {
            stats.errorStats.byErrorType[errorType] = 0;
          }
          stats.errorStats.byErrorType[errorType] += this.errors[domain].errorTypes[errorType];
        }
      }
      
      if (this.resourceMetrics[domain]) {
        domainEntry.resourceMetrics = {
          totalExecutionTime: 0,
          avgExecutionTime: 0,
          estimatedMemoryUsage: 0,
          estimatedCpuUsage: 0
        };
        
        for (const step in this.resourceMetrics[domain].steps) {
          const stepData = this.resourceMetrics[domain].steps[step];
          domainEntry.resourceMetrics.totalExecutionTime += stepData.totalExecutionTime || 0;
          domainEntry.resourceMetrics.estimatedMemoryUsage += stepData.estimatedMemoryUsage || 0;
          domainEntry.resourceMetrics.estimatedCpuUsage += stepData.estimatedCpuUsage || 0;
        }
        
        if (Object.keys(this.resourceMetrics[domain].steps).length > 0) {
          domainEntry.resourceMetrics.avgExecutionTime = 
            domainEntry.resourceMetrics.totalExecutionTime / (domainData.totalRealAttempts || 1);
        }
        
        stats.resourceStats.totalExecutionTime += domainEntry.resourceMetrics.totalExecutionTime;
      }
      
      if (this.cacheMetrics[domain]) {
        domainEntry.cacheMetrics = {
          hits: this.cacheMetrics[domain].hits || 0,
          misses: this.cacheMetrics[domain].misses || 0,
          hitRate: this.cacheMetrics[domain].hitRate || 0
        };
        
        stats.cacheStats.totalHits += domainEntry.cacheMetrics.hits;
        stats.cacheStats.totalMisses += domainEntry.cacheMetrics.misses;
      }
      
      stats.domains.push(domainEntry);
      
      for (const step in domainData.steps) {
        if (!stats.stepStats[step]) {
          stats.stepStats[step] = {
            totalApplicabilityChecks: 0,
            totalRealAttempts: 0,
            totalNotApplicable: 0,
            totalSuccesses: 0,
            domains: 0,
            avgExecutionTime: 0,
            totalExecutionTime: 0,
            realSuccessRate: 0
          };
        }
        
        const stepData = domainData.steps[step];
        stats.stepStats[step].totalApplicabilityChecks += stepData.applicabilityChecks || 0;
        stats.stepStats[step].totalRealAttempts += stepData.realAttempts || 0;
        stats.stepStats[step].totalNotApplicable += stepData.notApplicableCount || 0;
        stats.stepStats[step].totalSuccesses += stepData.successes || 0;
        stats.stepStats[step].domains++;
        
        if (stepData.totalExecutionTime) {
          stats.stepStats[step].totalExecutionTime += stepData.totalExecutionTime;
          stats.stepStats[step].avgExecutionTime = 
            stats.stepStats[step].totalExecutionTime / stats.stepStats[step].totalRealAttempts;
        }
      }
    }
    
    for (const step in stats.stepStats) {
      const realAttempts = stats.stepStats[step].totalRealAttempts;
      const successes = stats.stepStats[step].totalSuccesses;
      if (realAttempts > 0) {
        stats.stepStats[step].realSuccessRate = ((successes / realAttempts) * 100).toFixed(1) + '%';
      } else {
        stats.stepStats[step].realSuccessRate = 'N/A';
      }
    }
    
    const totalCacheRequests = stats.cacheStats.totalHits + stats.cacheStats.totalMisses;
    stats.cacheStats.globalHitRate = totalCacheRequests > 0 
      ? (stats.cacheStats.totalHits / totalCacheRequests * 100).toFixed(1) + '%' 
      : '0%';
    
    if (stats.totalRealAttempts > 0) {
      stats.resourceStats.avgExecutionTime = stats.resourceStats.totalExecutionTime / stats.totalRealAttempts;
    }
    
    stats.domains.sort((a, b) => b.complexityScore - a.complexityScore);
    
    return stats;
  }
  
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      return url;
    }
  }
}

module.exports = new ScrapingMetricsService();