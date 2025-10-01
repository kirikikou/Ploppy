const BaseScraperStep = require('./BaseScraperStep');
const { chromium } = require('playwright');
const IntelligentInteractionMixin = require('../IntelligentInteractionMixin');
const SmartElementValidator = require('../smartElementValidator');
const config = require('../../config');

class IframeAwareStep extends BaseScraperStep {
  constructor() {
    super('iframe-aware-rendering', 7);
    this.maxExecutionTime = 45000;
    this.maxIframes = 10;
    this.iframeTimeout = 15000;
  }

  async isApplicable(url, context = {}) {
    const urlLower = url.toLowerCase();
    
    if (context.detectedPlatform) {
      const iframePlatforms = ['Jobvite', 'iCIMS', 'Taleo', 'Personio', 'TeamTailor'];
      if (iframePlatforms.includes(context.detectedPlatform)) {
        config.smartLog('platform', `Applicable: ${context.detectedPlatform} platform detected`);
        return true;
      }
    }
    
    const iframeIndicators = [
      '/embed', 'iframe', 'widget', 'portal',
      'jobvite.com', 'icims.com', 'taleo.net'
    ];
    
    if (iframeIndicators.some(indicator => urlLower.includes(indicator))) {
      config.smartLog('platform', `Applicable: iframe indicator detected in URL`);
      return true;
    }
    
    if (context.previousStepResult?.requiresIframe) {
      config.smartLog('steps', `Applicable: Previous step indicates iframe required`);
      return true;
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ${this.name} for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);
    
    const startTime = Date.now();
    let browser = null;
    let result = null;
    let scrapingError = null;
    
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ]
      });
      
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: dict.getCurrentLanguage() === 'fr' ? 'fr-FR' : 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': dict.getCurrentLanguage() === 'fr' ? 'fr-FR,fr;q=0.9' : 'en-US,en;q=0.9'
        }
      });
      
      const page = await context.newPage();
      
      config.smartLog('steps', `Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      config.smartLog('steps', `Handling cookies and interactions with mixins`);
      await IntelligentInteractionMixin.handleGenericInteractions(page, dict, {
        handleShowMore: true,
        handlePagination: false,
        maxShowMore: 2
      });
      
      await IntelligentInteractionMixin.waitForContentLoad(page, dict);
      
      let allJobs = [];
      
      config.smartLog('steps', `Extracting jobs from main page`);
      const mainPageJobs = await this.extractJobsFromPage(page, url);
      allJobs.push(...mainPageJobs);
      
      config.smartLog('steps', `Looking for iframes`);
      const iframes = await this.findRelevantIframes(page);
      config.smartLog('steps', `Found ${iframes.length} potentially relevant iframes`);
      
      for (const iframeInfo of iframes.slice(0, this.maxIframes)) {
        try {
          config.smartLog('steps', `Processing iframe: ${iframeInfo.src}`);
          const iframeJobs = await this.scrapeIframe(page, iframeInfo, dict);
          allJobs.push(...iframeJobs);
        } catch (error) {
          config.smartLog('fail', `Error processing iframe ${iframeInfo.src}: ${error.message}`);
        }
      }
      
      const uniqueJobs = this.deduplicateJobs(allJobs);
      config.smartLog('steps', `Total unique jobs found: ${uniqueJobs.length}`);
      
      await browser.close();
      
      if (uniqueJobs.length > 0) {
        result = {
          url: url,
          title: await page.title(),
          text: this.extractTextFromJobs(uniqueJobs),
          links: uniqueJobs,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: this.detectPlatformFromJobs(uniqueJobs),
          variantType: 'iframe-aware',
          jobTermsFound: this.countJobTerms(this.extractTextFromJobs(uniqueJobs)),
          isEmpty: false,
          method: 'iframe-aware-rendering',
          executionTime: Date.now() - startTime,
          iframesProcessed: iframes.length
        };
        
        config.smartLog('win', `Successfully found ${uniqueJobs.length} jobs via iframe processing`);
        return result;
      }
      
      result = {
        url: url,
        title: await page.title(),
        text: 'No jobs found in main page or iframes',
        links: [],
        scrapedAt: new Date().toISOString(),
        variantType: 'iframe-aware-empty',
        jobTermsFound: 0,
        isEmpty: true,
        method: 'iframe-aware-rendering',
        executionTime: Date.now() - startTime,
        iframesProcessed: iframes.length
      };
      
      config.smartLog('fail', `No jobs found in main page or iframes`);
      scrapingError = new Error('No jobs found in main page or iframes');
      return null;
      
    } catch (error) {
      config.smartLog('fail', `Error: ${error.message}`);
      if (browser) await browser.close();
      scrapingError = error;
      return null;
    }
  }

  async findRelevantIframes(page) {
    return await page.evaluate(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return iframes
        .filter(iframe => {
          const src = iframe.src || iframe.getAttribute('src') || '';
          const id = iframe.id || '';
          const className = iframe.className || '';
          
          if (!src || src === 'about:blank') return false;
          
          const relevantKeywords = [
            'job', 'career', 'hiring', 'recruit', 'employ',
            'icims', 'jobvite', 'taleo', 'workday', 'greenhouse',
            'lever', 'bamboo', 'smartrecruiters', 'brassring'
          ];
          
          const srcLower = src.toLowerCase();
          const idLower = id.toLowerCase();
          const classLower = className.toLowerCase();
          
          return relevantKeywords.some(keyword => 
            srcLower.includes(keyword) || 
            idLower.includes(keyword) || 
            classLower.includes(keyword)
          );
        })
        .map(iframe => ({
          src: iframe.src,
          id: iframe.id,
          className: iframe.className,
          width: iframe.width,
          height: iframe.height
        }));
    });
  }

  async scrapeIframe(page, iframeInfo, dict) {
    try {
      const frame = await page.frame({ url: iframeInfo.src });
      if (!frame) {
        config.smartLog('fail', `Could not access iframe: ${iframeInfo.src}`);
        return [];
      }
      
      await frame.waitForLoadState('domcontentloaded', { timeout: this.iframeTimeout });
      
      try {
        await frame.evaluate((selectors, textSelectors) => {
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              if (el.offsetParent) {
                el.click();
                return;
              }
            }
          }
          
          const buttons = document.querySelectorAll('button, a, div[role="button"]');
          for (const btn of buttons) {
            const text = btn.textContent.toLowerCase().trim();
            if (textSelectors.some(t => {
              if (typeof t === 'string') {
                return text === t.toLowerCase() || text.includes(t.toLowerCase());
              } else if (t instanceof RegExp) {
                return t.test(text);
              }
              return false;
            })) {
              if (text.length < 25 && btn.offsetParent) {
                btn.click();
                return;
              }
            }
          }
        }, dict.cookieSelectors, dict.cookieTextSelectors);
      } catch (e) {
        config.smartLog('fail', `Cookie handling in iframe failed: ${e.message}`);
      }
      
      const jobs = await SmartElementValidator.findJobListings(frame, dict, { limit: 20 });
      
      config.smartLog('steps', `Found ${jobs.length} jobs in iframe: ${iframeInfo.src}`);
      
      return jobs.map(job => ({
        url: job.url || iframeInfo.src,
        text: job.text,
        isJobPosting: true,
        linkType: 'job_posting',
        confidence: job.hasJobTerms ? 0.9 : 0.7,
        source: 'iframe',
        iframeSrc: iframeInfo.src
      }));
      
    } catch (error) {
      config.smartLog('fail', `Error scraping iframe ${iframeInfo.src}: ${error.message}`);
      return [];
    }
  }

  async extractJobsFromPage(page, url) {
    try {
      const dict = this.getDictionary();
      
      const jobs = await SmartElementValidator.findJobListings(page, dict, { limit: 30 });
      
      config.smartLog('steps', `Found ${jobs.length} jobs on main page`);
      
      return jobs.map(job => ({
        url: job.url || url,
        text: job.text,
        isJobPosting: true,
        linkType: 'job_posting',
        confidence: job.hasJobTerms ? 0.95 : 0.8,
        source: 'main_page'
      }));
      
    } catch (error) {
      config.smartLog('fail', `Error extracting jobs from main page: ${error.message}`);
      return [];
    }
  }

  deduplicateJobs(jobs) {
    const unique = [];
    const seenTexts = new Set();
    const seenUrls = new Set();
    
    for (const job of jobs) {
      const key = `${job.text.toLowerCase().trim()}-${job.url}`;
      if (!seenTexts.has(job.text.toLowerCase().trim()) && !seenUrls.has(job.url)) {
        seenTexts.add(job.text.toLowerCase().trim());
        if (job.url) seenUrls.add(job.url);
        unique.push(job);
      }
    }
    
    return unique;
  }

  extractTextFromJobs(jobs) {
    return jobs.map(job => job.text).join('\n');
  }

  detectPlatformFromJobs(jobs) {
    const platforms = {
      'Jobvite': ['jobvite.com', 'jv-'],
      'iCIMS': ['icims.com', 'icims'],
      'Taleo': ['taleo.net', 'taleo'],
      'Workday': ['workday', 'wd5']
    };
    
    for (const [platform, indicators] of Object.entries(platforms)) {
      if (jobs.some(job => 
        indicators.some(indicator => 
          (job.url && job.url.includes(indicator)) ||
          (job.iframeSrc && job.iframeSrc.includes(indicator))
        )
      )) {
        return platform;
      }
    }
    
    return 'Unknown';
  }

  countJobTerms(text) {
    if (!text) return 0;
    
    const jobTerms = this.getJobTerms();
    const lowerText = text.toLowerCase();
    let count = 0;
    
    for (const term of jobTerms) {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      const matches = lowerText.match(regex);
      if (matches) count += matches.length;
    }
    
    return count;
  }

  getStepMetadata() {
    const dict = this.getDictionary();
    return {
      name: this.name,
      description: 'Advanced iframe-aware scraper with intelligent interaction handling',
      priority: this.priority,
      platforms: ['Jobvite', 'iCIMS', 'Taleo', 'Personio', 'TeamTailor'],
      methods: ['iframe-aware-rendering'],
      features: [
        'Intelligent cookie and popup handling via mixins',
        'Smart element validation for job detection',
        'Multi-iframe content extraction',
        'Multilingual interaction support',
        'Advanced job deduplication',
        'Platform-specific iframe detection',
        'Adaptive content loading'
      ],
      supportedLanguages: dict.getSupportedLanguages(),
      recommendedFor: [
        'Sites with embedded job widgets',
        'Iframe-based recruitment platforms',
        'Complex multi-frame job portals'
      ]
    };
  }
}

module.exports = IframeAwareStep;