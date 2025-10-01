const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const config = require('../../config');
const fs = require('fs').promises;
const path = require('path');

class WorkdayStep extends BaseScraperStep {
  constructor() {
    super('workday-step', 2);
    this.maxExecutionTime = 30000;
    this.apiTimeout = 15000;
  }

  async isApplicable(url, context = {}) {
    const urlLower = url.toLowerCase();
    
    if (context.detectedPlatform === 'Workday') {
      return true;
    }
    
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const workdayConfig = platforms.find(p => p.name === 'Workday');
    
    if (workdayConfig && workdayConfig.patterns) {
      return workdayConfig.patterns.some(pattern => urlLower.includes(pattern));
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting Workday scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);
    
    const startTime = Date.now();
    let result = null;
    let scrapingError = null;
    
    try {
      const urlObj = new URL(url);
      const isMainPage = !url.includes('/job/');
      
      if (isMainPage) {
        result = await this.scrapeJobListings(url, options);
      } else {
        result = await this.scrapeJobDetail(url, options);
      }
      
      if (result && result.links && result.links.length > 0) {
        config.smartLog('win', `Successfully found ${result.links.length} jobs`);
      } else {
        config.smartLog('fail', `No jobs found`);
        scrapingError = new Error('No jobs found');
      }
      
      if (config.shouldExportDebug(result, scrapingError, this.name)) {
        await this.exportDebugInfo(url, scrapingError);
      }
      
    } catch (error) {
      config.smartLog('fail', `Error: ${error.message}`);
      scrapingError = error;
    }
    
    return result;
  }

  async scrapeJobListings(url, options) {
    config.smartLog('steps', `Scraping job listings from ${url}`);
    
    const urlObj = new URL(url);
    const tenant = this.extractTenant(urlObj.hostname);
    const locale = this.extractLocale(url, this.getDictionary().getCurrentLanguage());
    
    const apiResult = await this.tryAPIApproach(url, tenant, locale);
    if (apiResult) return apiResult;
    
    const headlessResult = await this.tryHeadlessApproach(url, options);
    if (headlessResult) return headlessResult;
    
    const iframeResult = await this.tryIframeApproach(url, options);
    if (iframeResult) return iframeResult;
    
    config.smartLog('fail', `All approaches failed for ${url}`);
    return null;
  }

  async tryAPIApproach(url, tenant, locale) {
    config.smartLog('steps', `Trying API approach for tenant: ${tenant}, locale: ${locale}`);
    
    try {
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const workdayConfig = platforms.find(p => p.name === 'Workday');
      const apiEndpoints = workdayConfig?.apiEndpoints || [
        `/wday/cxs/${tenant}/workers/v2/searchPosts`,
        `/wday/cxs/${tenant}/siteapply/v2/api/recruiting/sites/1/jobpostings`,
        `/services/recruiting/jobfamily/worker/jobListing`,
        `/REST/recruiting/v1/jobpostings`,
        `/api/v1/postings`
      ];
      
      const baseUrl = `https://${tenant}.wd5.myworkdayjobs.com`;
      
      for (const endpoint of apiEndpoints) {
        const apiUrl = `${baseUrl}${endpoint}`;
        config.smartLog('steps', `Trying API: ${apiUrl}`);
        
        try {
          const response = await axios.post(apiUrl, {
            searchText: '',
            offset: 0,
            limit: 100,
            appliedFacets: {},
            locale: locale
          }, {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept-Language': this.getAcceptLanguageHeader()
            },
            timeout: this.apiTimeout
          });
          
          if (response.data) {
            const jobs = this.extractJobsFromAPIResponse(response.data, url);
            if (jobs.length > 0) {
              return this.formatResult(url, jobs, 'workday-api');
            }
          }
        } catch (apiError) {
          config.smartLog('fail', `API error: ${apiError.message}`);
        }
      }
      
      const searchParams = new URLSearchParams({
        q: '',
        lang: locale,
        limit: 100,
        offset: 0
      });
      
      const searchUrl = `${baseUrl}/wday/cxs/${tenant}/workers/search?${searchParams}`;
      config.smartLog('steps', `Trying search API: ${searchUrl}`);
      
      const searchResponse = await axios.get(searchUrl, {
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept-Language': this.getAcceptLanguageHeader()
        },
        timeout: this.apiTimeout
      });
      
      if (searchResponse.data) {
        const jobs = this.extractJobsFromAPIResponse(searchResponse.data, url);
        if (jobs.length > 0) {
          return this.formatResult(url, jobs, 'workday-search-api');
        }
      }
    } catch (error) {
      config.smartLog('fail', `API approach failed: ${error.message}`);
    }
    
    return null;
  }

  async tryHeadlessApproach(url, options) {
    config.smartLog('steps', `Trying headless approach for ${url}`);
    let browser = null;
    
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: this.getBrowserLocale(),
        extraHTTPHeaders: {
          'Accept-Language': this.getAcceptLanguageHeader()
        }
      });
      
      const page = await context.newPage();
      
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'media', 'font'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
      
      config.smartLog('steps', `Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      
      await page.waitForTimeout(3000);
      
      await this.handleCookiesAndPopups(page);
      
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const workdayConfig = platforms.find(p => p.name === 'Workday');
      const workdaySelectors = workdayConfig?.selectors || ['[data-automation-id="jobList"]', '.WLWO', '[role="list"]'];
      
      const hasJobList = await page.evaluate((selectors) => {
        return selectors.some(sel => document.querySelector(sel) !== null);
      }, workdaySelectors);
      
      if (!hasJobList) {
        config.smartLog('steps', `Waiting for job list to load`);
        const selectorString = workdaySelectors.join(', ');
        await page.waitForSelector(selectorString, { 
          timeout: 10000 
        }).catch(() => {});
      }
      
      await this.loadAllJobs(page);
      
      const jobs = await this.extractJobsFromPage(page);
      
      config.smartLog('steps', `Found ${jobs.length} jobs via headless`);
      
      await browser.close();
      
      if (jobs.length > 0) {
        return this.formatResult(url, jobs, 'workday-headless');
      }
      
    } catch (error) {
      config.smartLog('fail', `Headless error: ${error.message}`);
      if (browser) await browser.close();
    }
    
    return null;
  }

  async tryIframeApproach(url, options) {
    config.smartLog('steps', `Trying iframe approach for ${url}`);
    
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': this.getAcceptLanguageHeader()
        },
        timeout: 10000
      });
      
      const $ = cheerio.load(response.data);
      
      const iframes = $('iframe');
      config.smartLog('steps', `Found ${iframes.length} iframes`);
      
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const workdayConfig = platforms.find(p => p.name === 'Workday');
      const workdayPatterns = workdayConfig?.patterns || ['workday', 'wd'];
      
      for (let i = 0; i < iframes.length; i++) {
        const iframe = iframes.eq(i);
        const src = iframe.attr('src');
        
        if (src && workdayPatterns.some(pattern => src.includes(pattern))) {
          config.smartLog('steps', `Found Workday iframe: ${src}`);
          
          const iframeUrl = new URL(src, url).href;
          const iframeResponse = await axios.get(iframeUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': url,
              'Accept-Language': this.getAcceptLanguageHeader()
            },
            timeout: 10000
          });
          
          const $iframe = cheerio.load(iframeResponse.data);
          const jobs = this.extractJobsFromHTML($iframe, iframeUrl);
          
          if (jobs.length > 0) {
            return this.formatResult(url, jobs, 'workday-iframe');
          }
        }
      }
      
      const directJobs = this.extractJobsFromHTML($, url);
      if (directJobs.length > 0) {
        return this.formatResult(url, directJobs, 'workday-html');
      }
      
    } catch (error) {
      config.smartLog('fail', `Iframe error: ${error.message}`);
    }
    
    return null;
  }

  async loadAllJobs(page) {
    config.smartLog('steps', `Loading all jobs`);
    
    const showMoreSelectors = this.getShowMoreSelectors();
    const showMoreTextSelectors = this.getShowMoreTextSelectors();
    
    let previousHeight = 0;
    let currentHeight = await page.evaluate(() => document.body.scrollHeight);
    let attempts = 0;
    
    while (previousHeight !== currentHeight && attempts < 10) {
      previousHeight = currentHeight;
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      
      for (const selector of showMoreSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const element of elements) {
            try {
              const isVisible = await element.isVisible();
              if (isVisible) {
                await element.click();
                config.smartLog('steps', `Clicked show more button: ${selector}`);
                await page.waitForTimeout(2000);
                break;
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      
      await page.evaluate((textSelectors) => {
        const buttons = document.querySelectorAll('button, [role="button"], a, input[type="button"]');
        
        for (const button of buttons) {
          const text = (button.textContent || button.value || '').trim().toLowerCase();
          
          if (text.length > 0 && text.length < 50) {
            const isShowMore = textSelectors.some(pattern => {
              if (typeof pattern === 'string') {
                return text === pattern.toLowerCase() || text.includes(pattern.toLowerCase());
              } else if (pattern instanceof RegExp) {
                return pattern.test(text);
              }
              return false;
            });
            
            if (isShowMore) {
              try {
                button.click();
                return;
              } catch (e) {}
            }
          }
        }
      }, showMoreTextSelectors);
      
      currentHeight = await page.evaluate(() => document.body.scrollHeight);
      attempts++;
    }
    
    config.smartLog('steps', `Finished loading jobs after ${attempts} attempts`);
  }

  async handleCookiesAndPopups(page) {
    try {
      const cookieSelectors = this.getCookieSelectors();
      const cookieTextSelectors = this.getCookieTextSelectors();
      
      for (const selector of cookieSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await element.isVisible();
            if (isVisible) {
              await element.click();
              config.smartLog('steps', `Clicked cookie selector: ${selector}`);
              await page.waitForTimeout(500);
              break;
            }
          }
        } catch (e) {}
      }
      
      await page.evaluate((textSelectors) => {
        const buttons = document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
        
        for (const button of buttons) {
          const text = (button.textContent || button.value || '').trim();
          const textLower = text.toLowerCase();
          
          if (text.length > 0 && text.length < 50) {
            const isMatch = textSelectors.some(pattern => {
              if (typeof pattern === 'string') {
                return textLower === pattern.toLowerCase() || 
                       textLower.includes(pattern.toLowerCase());
              } else if (pattern instanceof RegExp) {
                return pattern.test(text);
              }
              return false;
            });
            
            if (isMatch) {
              try {
                button.click();
                return;
              } catch (e) {}
            }
          }
        }
      }, cookieTextSelectors);
      
    } catch (error) {
      config.smartLog('fail', `Cookie handling error: ${error.message}`);
    }
  }

  async extractJobsFromPage(page) {
    const jobListingSelectors = this.getJobListingSelectors();
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const workdayConfig = platforms.find(p => p.name === 'Workday');
    const workdaySelectors = workdayConfig?.selectors || [
      '[data-automation-id="jobItem"]',
      'li[data-uxi-element-id*="job"]',
      '.WLWO',
      '[role="listitem"] a[href*="/job/"]',
      'a[href*="/job/"][data-automation-id]',
      '.css-1q2dra3',
      'div[data-automation-id="jobTile"]'
    ];
    
    return await page.evaluate((selectors) => {
      const { jobSelectors, workdaySelectors } = selectors;
      const results = [];
      
      const allSelectors = [...workdaySelectors, ...jobSelectors];
      
      for (const selector of allSelectors) {
        const elements = document.querySelectorAll(selector);
        
        elements.forEach(el => {
          let title = '';
          let jobUrl = '';
          let location = '';
          let postedDate = '';
          
          const titleEl = el.querySelector('[data-automation-id="jobTitle"], h3, .job-title, h1, h2, h4, .title');
          if (titleEl) title = titleEl.textContent.trim();
          
          const linkEl = el.querySelector('a[href*="/job/"]') || el.closest('a[href*="/job/"]');
          if (linkEl) jobUrl = linkEl.href;
          
          const locationEl = el.querySelector('[data-automation-id="location"], .job-location, .location, [class*="location"]');
          if (locationEl) location = locationEl.textContent.trim();
          
          const dateEl = el.querySelector('[data-automation-id="postedOn"], .posted-date, .date, [class*="date"]');
          if (dateEl) postedDate = dateEl.textContent.trim();
          
          if (!title && el.textContent) {
            const text = el.textContent.trim();
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length > 0) title = lines[0];
          }
          
          if (title && title.length > 3 && title.length < 200) {
            const isDuplicate = results.some(r => r.title === title);
            if (!isDuplicate) {
              results.push({
                title,
                url: jobUrl || '',
                location: location || '',
                postedDate: postedDate || ''
              });
            }
          }
        });
      }
      
      if (results.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/job/"]');
        allLinks.forEach(link => {
          const title = link.textContent.trim();
          if (title && title.length > 3 && title.length < 200) {
            const isDuplicate = results.some(r => r.title === title);
            if (!isDuplicate) {
              results.push({
                title,
                url: link.href,
                location: '',
                postedDate: ''
              });
            }
          }
        });
      }
      
      return results;
    }, { jobSelectors: jobListingSelectors, workdaySelectors: workdaySelectors });
  }

  extractJobsFromAPIResponse(data, baseUrl) {
    const jobs = [];
    
    try {
      let jobArray = [];
      
      if (data.jobPostings) jobArray = data.jobPostings;
      else if (data.data && data.data.jobPostings) jobArray = data.data.jobPostings;
      else if (data.results) jobArray = data.results;
      else if (Array.isArray(data)) jobArray = data;
      
      for (const job of jobArray) {
        const title = job.title || job.jobTitle || job.postingTitle || '';
        const jobId = job.bulletFields?.[0] || job.id || job.jobId || '';
        const location = job.locationsText || job.location || job.jobLocation || '';
        const postedDate = job.postedOn || job.postedDate || '';
        
        if (title) {
          const jobUrl = jobId ? `${baseUrl}/job/${jobId}` : '';
          jobs.push({
            title,
            url: jobUrl,
            location,
            postedDate
          });
        }
      }
    } catch (error) {
      config.smartLog('fail', `Error parsing API response: ${error.message}`);
    }
    
    return jobs;
  }

  extractJobsFromHTML($, baseUrl) {
    const jobs = [];
    const jobListingSelectors = this.getJobListingSelectors();
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const workdayConfig = platforms.find(p => p.name === 'Workday');
    const workdaySelectors = workdayConfig?.selectors || [
      'a[href*="/job/"]',
      '[data-automation-id="jobItem"]',
      '.job-listing',
      '.workday-job',
      'li[role="listitem"]'
    ];
    
    const allSelectors = [...workdaySelectors, ...jobListingSelectors];
    
    for (const selector of allSelectors) {
      $(selector).each((i, el) => {
        const $el = $(el);
        let title = '';
        let jobUrl = '';
        
        if ($el.is('a')) {
          title = $el.text().trim();
          jobUrl = $el.attr('href');
        } else {
          const link = $el.find('a[href*="/job/"]').first();
          if (link.length) {
            title = link.text().trim() || $el.text().trim();
            jobUrl = link.attr('href');
          }
        }
        
        if (title && title.length > 3) {
          if (jobUrl && !jobUrl.startsWith('http')) {
            jobUrl = new URL(jobUrl, baseUrl).href;
          }
          
          const isDuplicate = jobs.some(j => j.title === title);
          if (!isDuplicate) {
            jobs.push({
              title,
              url: jobUrl || '',
              location: '',
              postedDate: ''
            });
          }
        }
      });
      
      if (jobs.length > 0) break;
    }
    
    return jobs;
  }

  formatResult(url, jobs, method) {
    const links = jobs.map(job => ({
      url: job.url || url,
      text: job.title,
      isJobPosting: true,
      linkType: 'job_posting',
      confidence: 0.95,
      location: job.location || '',
      postedDate: job.postedDate || ''
    }));
    
    const text = jobs.map(job => 
      `${job.title} ${job.location} ${job.postedDate}`.trim()
    ).join('\n');
    
    return {
      url,
      title: 'Workday Career Opportunities',
      text,
      links,
      scrapedAt: new Date().toISOString(),
      detectedPlatform: 'Workday',
      variantType: method,
      jobTermsFound: this.countJobTerms(text),
      isEmpty: links.length === 0,
      method: this.name
    };
  }

  extractTenant(hostname) {
    const parts = hostname.split('.');
    return parts[0];
  }

  extractLocale(url, currentLang) {
    const localeMatch = url.match(/\/([a-z]{2}-[A-Z]{2})\//);
    if (localeMatch) return localeMatch[1];
    
    const dict = this.getDictionary();
    const universal = dict.getUniversalSelectors();
    const localeMap = universal.localeMapping || {};
    return localeMap[currentLang] || 'en-US';
  }
  
  getBrowserLocale() {
    const currentLang = this.getDictionary().getCurrentLanguage();
    const dict = this.getDictionary();
    const universal = dict.getUniversalSelectors();
    const localeMap = universal.localeMapping || {};
    return localeMap[currentLang] || 'en-US';
  }
  
  getAcceptLanguageHeader() {
    const currentLang = this.getDictionary().getCurrentLanguage();
    const dict = this.getDictionary();
    const universal = dict.getUniversalSelectors();
    const headerMap = universal.languageHeaders || {};
    return headerMap[currentLang] || 'en-US,en;q=0.9';
  }

  async scrapeJobDetail(url, options) {
    config.smartLog('steps', `Scraping job detail from ${url}`);
    
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': this.getAcceptLanguageHeader()
        },
        timeout: 10000
      });
      
      const $ = cheerio.load(response.data);
      const title = $('h1, [data-automation-id="jobPostingTitle"]').first().text().trim();
      const description = $('[data-automation-id="jobPostingDescription"], .job-description').text().trim();
      
      if (title) {
        return {
          url,
          title,
          text: `${title}\n\n${description}`,
          links: [{ url, text: title, isJobPosting: true }],
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'Workday',
          method: 'workday-detail'
        };
      }
    } catch (error) {
      config.smartLog('fail', `Job detail error: ${error.message}`);
    }
    
    return null;
  }

  async exportDebugInfo(url, error) {
    try {
      const debugData = {
        url: url,
        error: error?.message || 'Unknown error',
        timestamp: new Date().toISOString(),
        step: this.name
      };
      
      await fs.writeFile(
        path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.json`),
        JSON.stringify(debugData, null, 2)
      );
    } catch (e) {}
  }

  isResultValid(result) {
    if (!super.isResultValid(result)) return false;
    return result.links && result.links.length > 0;
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
      description: 'Comprehensive Workday scraper with API, headless, and iframe approaches',
      priority: this.priority,
      platforms: ['Workday'],
      methods: ['workday-api', 'workday-headless', 'workday-iframe', 'workday-html'],
      features: [
        'Multi-approach scraping strategy',
        'Workday API integration',
        'Headless browser automation',
        'Iframe content extraction',
        'Multilingual cookie handling',
        'Smart job loading with pagination',
        'Tenant and locale detection',
        'Platform-agnostic job detection',
        'Duplicate job filtering'
      ],
      supportedLanguages: dict.getSupportedLanguages(),
      recommendedFor: [
        'Workday career sites',
        'Multi-tenant Workday instances',
        'Sites with complex job loading'
      ]
    };
  }
}

module.exports = WorkdayStep;