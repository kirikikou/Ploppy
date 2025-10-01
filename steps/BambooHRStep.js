const { chromium } = require('playwright');
const cheerio = require('cheerio');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const { extractContentFromCheerio } = require('../helpers');
const config = require('../../config');

class BambooHRStep extends BaseScraperStep {
  constructor() {
    super('bamboohr-step', 2);
    this.browser = null;
    this.bambooHRPlatform = null;
  }
  
  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          ...config.playwrightArgs,
          '--disable-blink-features=AutomationControlled',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      });
    }
    return this.browser;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async isApplicable(url, context = {}) {
    config.smartLog('steps', `Checking applicability for ${url}`);
    
    const urlLower = url.toLowerCase();
    
    let isBambooHRUrl = false;
    if (this.bambooHRPlatform && this.bambooHRPlatform.patterns) {
      isBambooHRUrl = this.bambooHRPlatform.patterns.some(pattern => 
        urlLower.includes(pattern.toLowerCase())
      );
    }
    
    const detectedPlatformName = typeof context.detectedPlatform === 'string' ? context.detectedPlatform : context.detectedPlatform?.name;
    const optionsDetectedPlatformName = typeof context.options?.detectedPlatform === 'string' ? context.options.detectedPlatform : context.options?.detectedPlatform?.name;
    
    const isDetectedPlatform = detectedPlatformName === 'BambooHR';
    const isDetectedInOptions = optionsDetectedPlatformName === 'BambooHR';
    
    config.smartLog('platform', `Detection checks - URL match: ${isBambooHRUrl}, Context platform: ${detectedPlatformName}, Options platform: ${optionsDetectedPlatformName}`);
    
    if (detectedPlatformName && detectedPlatformName !== 'BambooHR') {
      config.smartLog('platform', `Not applicable - Different platform detected: ${detectedPlatformName}`);
      return false;
    }
    
    if (optionsDetectedPlatformName && optionsDetectedPlatformName !== 'BambooHR') {
      config.smartLog('platform', `Not applicable - Different platform detected in options: ${optionsDetectedPlatformName}`);
      return false;
    }
    
    if (isBambooHRUrl || isDetectedPlatform || isDetectedInOptions) {
      config.smartLog('platform', `Applicable for ${url} - BambooHR explicitly detected`);
      return true;
    }
    
    let htmlContent = context.htmlContent || context.html || '';
    
    if (htmlContent) {
      const hasHTMLIndicators = this.checkForBambooHRIndicators(htmlContent);
      config.smartLog('platform', `HTML indicators from pre-fetched content: ${hasHTMLIndicators}`);
      
      if (hasHTMLIndicators) {
        if (this.hasConflictingPlatformIndicators(htmlContent)) {
          config.smartLog('platform', `Not applicable - Conflicting platform indicators found`);
          return false;
        }
        
        config.smartLog('platform', `Applicable for ${url} - BambooHR indicators found in HTML`);
        return true;
      }
    }
    
    if (!htmlContent && !detectedPlatformName) {
      try {
        config.smartLog('steps', `Fetching HTML to check BambooHR applicability for ${url}`);
        
        const response = await axios.get(url, {
          timeout: 6000,
          maxRedirects: 2,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        
        htmlContent = response.data;
        
        if (this.hasConflictingPlatformIndicators(htmlContent)) {
          config.smartLog('platform', `Not applicable - Conflicting platform indicators found in fetched HTML`);
          return false;
        }
        
        const hasHTMLIndicators = this.checkForBambooHRIndicators(htmlContent);
        
        if (hasHTMLIndicators) {
          context.html = htmlContent;
          config.smartLog('platform', `Applicable for ${url} - BambooHR indicators found in fetched HTML`);
          return true;
        }
        
      } catch (error) {
        config.smartLog('fail', `Could not fetch HTML for applicability check: ${error.message}`);
      }
    }
    
    config.smartLog('platform', `Not applicable for ${url} - No BambooHR indicators found`);
    return false;
  }
  
  hasConflictingPlatformIndicators(htmlContent) {
    if (!htmlContent) return false;
    
    const htmlLower = htmlContent.toLowerCase();
    const dict = this.getDictionary();
    const allPlatforms = dict.knownJobPlatforms;
    
    for (const platform of allPlatforms) {
      if (platform.name === 'BambooHR') continue;
      
      const hasStrongIndicator = platform.indicators && platform.indicators.some(indicator => 
        htmlLower.includes(indicator.toLowerCase())
      );
      
      if (hasStrongIndicator) {
        config.smartLog('platform', `Found conflicting ${platform.name} indicator`);
        return true;
      }
    }
    
    return false;
  }
  
  checkForBambooHRIndicators(htmlContent) {
    if (!htmlContent) return false;
    
    const htmlLower = htmlContent.toLowerCase();
    
    const strongIndicators = [
      'bamboohr.com/jobs/embed',
      'bamboohr.com/careers',
      '.bamboohr.com/careers',
      'bamboo-datafeed',
      'bamboohr-ats-jobs-item',
      'bamboohr-ats-jobs-list',
      'bamboohr-ats-department-list',
      'bamboohr-ats-board'
    ];
    
    for (const indicator of strongIndicators) {
      if (htmlLower.includes(indicator)) {
        config.smartLog('platform', `Found strong BambooHR indicator: ${indicator}`);
        return true;
      }
    }
    
    const moderateIndicators = [
      'bamboohr-ats',
      'block-bamboo-hr',
      'bamboo-app',
      'bamboohr',
      'bamboo-hr'
    ];
    
    let moderateMatches = 0;
    const foundModerate = [];
    
    for (const indicator of moderateIndicators) {
      if (htmlLower.includes(indicator)) {
        moderateMatches++;
        foundModerate.push(indicator);
      }
    }
    
    if (moderateMatches >= 2) {
      config.smartLog('platform', `Found multiple moderate BambooHR indicators: ${foundModerate.join(', ')}`);
      return true;
    }
    
    let dictionaryMatches = 0;
    if (this.bambooHRPlatform && this.bambooHRPlatform.indicators) {
      for (const indicator of this.bambooHRPlatform.indicators) {
        if (htmlLower.includes(indicator.toLowerCase())) {
          dictionaryMatches++;
          if (dictionaryMatches >= 2) {
            config.smartLog('platform', `Found sufficient dictionary indicators for BambooHR`);
            return true;
          }
        }
      }
    }
    
    config.smartLog('platform', `BambooHR indicators check - Strong: 0, Moderate: ${moderateMatches}, Dictionary: ${dictionaryMatches} - Not sufficient`);
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting BambooHR specialized scraping for ${url}`);
    const startTime = Date.now();
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    this.bambooHRPlatform = dict.knownJobPlatforms.find(p => p.name === 'BambooHR');
    
    let result = null;
    let scrapingError = null;
    
    try {
      await this.initialize();
      
      const context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        bypassCSP: true
      });
      
      await context.route('**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf,eot}', route => route.abort());
      
      const page = await context.newPage();
      
      try {
        config.smartLog('steps', `Navigating to ${url}`);
        await page.goto(url, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        
        config.smartLog('steps', `Page loaded, handling cookies and waiting for content`);
        await this.handleCookieConsent(page);
        
        await this.waitForBambooHRContent(page);
        
        config.smartLog('steps', `Processing iframes`);
        const iframeResults = await this.processBambooHRIframes(page, url);
        
        config.smartLog('steps', `Extracting jobs from main page`);
        const directResults = await this.extractBambooHRJobs(page, url);
        
        const combinedResults = this.mergeResults(directResults, iframeResults);
        
        if (combinedResults && this.isResultValid(combinedResults)) {
          result = combinedResults;
          config.smartLog('win', `Successfully extracted ${result.links.length} jobs from BambooHR`);
        } else {
          config.smartLog('fail', `No valid results found`);
          scrapingError = new Error('No valid results found');
        }
        
        if (config.shouldExportDebug(result, scrapingError, this.name)) {
          const debugPromises = [
            page.screenshot({ fullPage: true }).then(screenshot => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.png`), 
                screenshot
              )
            ).catch(() => {}),
            page.content().then(html => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.html`), 
                html
              )
            ).catch(() => {})
          ];
          await Promise.all(debugPromises).catch(() => {});
        }
        
      } catch (error) {
        config.smartLog('fail', `Error in BambooHR scraping: ${error.message}`);
        scrapingError = error;
      } finally {
        await page.close();
        await context.close();
      }
      
      return result;
    } catch (error) {
      config.smartLog('fail', `Critical error: ${error.message}`);
      scrapingError = error;
      return null;
    }
  }
  
  async waitForBambooHRContent(page) {
    config.smartLog('steps', `Waiting for BambooHR content to load...`);
    const dict = this.getDictionary();
    const jobSelectors = dict.jobListingSelectors;
    
    try {
      await page.waitForFunction((selectors) => {
        const bambooSelectors = [
          '.BambooHR-ATS-Jobs-Item', '.BambooHR-ATS-Jobs-List', 
          '[class*="bamboo"]', '[class*="BambooHR"]'
        ];
        
        const allSelectors = [...selectors, ...bambooSelectors];
        const elements = document.querySelectorAll(allSelectors.join(', '));
        
        const hasTemplates = document.body.innerHTML.includes('{{ job.jobTitle') || 
                           document.body.innerHTML.includes('{{ department }}');
        const hasRealJobs = Array.from(elements).some(el => {
          const text = el.textContent || '';
          return text.length > 10 && !text.includes('{{') && !text.includes('}}');
        });
        
        return (hasRealJobs && !hasTemplates) || elements.length > 0;
      }, jobSelectors, { timeout: 15000 });
      
      config.smartLog('steps', `BambooHR content detected, waiting for stabilization...`);
      await randomDelay(3000, 5000);
      
    } catch (error) {
      config.smartLog('timeout', `Timeout waiting for BambooHR content, proceeding anyway: ${error.message}`);
      await randomDelay(8000, 12000);
    }
    
    try {
      await page.evaluate(() => {
        const scripts = document.querySelectorAll('script');
        let bambooScriptFound = false;
        
        for (const script of scripts) {
          const src = script.src || '';
          const content = script.textContent || '';
          
          if (src.includes('bamboo') || content.includes('BambooHR') || content.includes('bamboo')) {
            bambooScriptFound = true;
            break;
          }
        }
        
        if (bambooScriptFound) {
          return new Promise(resolve => setTimeout(resolve, 5000));
        }
      });
    } catch (error) {
      config.smartLog('fail', `Error waiting for scripts: ${error.message}`);
    }
  }
  
  async handleCookieConsent(page) {
    try {
      const dict = this.getDictionary();
      const cookieSelectors = dict.cookieSelectors;
      
      for (const selector of cookieSelectors) {
        try {
          const element = await page.$(selector);
          if (element && await element.isVisible()) {
            config.smartLog('steps', `Accepting cookies with: ${selector}`);
            await element.click();
            await randomDelay(1000, 2000);
            break;
          }
        } catch (e) {}
      }
    } catch (error) {
      config.smartLog('fail', `Cookie consent handling failed: ${error.message}`);
    }
  }
  
  async processBambooHRIframes(page, url) {
    try {
      const frames = page.frames();
      const bambooIframes = frames.filter(frame => {
        if (frame === page.mainFrame()) return false;
        const frameUrl = frame.url();
        return frameUrl && this.bambooHRPlatform && this.bambooHRPlatform.patterns && 
               this.bambooHRPlatform.patterns.some(pattern => frameUrl.includes(pattern));
      });
      
      if (bambooIframes.length === 0) {
        config.smartLog('steps', `No BambooHR iframes found`);
        return null;
      }
      
      config.smartLog('steps', `Processing ${bambooIframes.length} BambooHR iframes`);
      
      let aggregatedText = '';
      let aggregatedLinks = [];
      
      for (const iframe of bambooIframes) {
        try {
          config.smartLog('steps', `Processing iframe: ${iframe.url()}`);
          
          await iframe.waitForLoadState('domcontentloaded', { timeout: 10000 });
          await randomDelay(3000, 5000);
          
          const frameContent = await iframe.content();
          const $ = cheerio.load(frameContent);
          
          const frameJobs = this.extractJobsFromCheerio($, iframe.url());
          
          if (frameJobs.links.length > 0) {
            aggregatedText += ' ' + frameJobs.text;
            aggregatedLinks = [...aggregatedLinks, ...frameJobs.links];
            config.smartLog('win', `Extracted ${frameJobs.links.length} jobs from iframe`);
          }
          
        } catch (error) {
          config.smartLog('fail', `Error processing iframe: ${error.message}`);
        }
      }
      
      if (aggregatedLinks.length > 0) {
        return {
          url,
          title: 'BambooHR Jobs (Iframe)',
          text: aggregatedText,
          links: aggregatedLinks,
          scrapedAt: new Date().toISOString(),
          method: this.name + '-iframe'
        };
      }
      
      return null;
    } catch (error) {
      config.smartLog('fail', `Error in iframe processing: ${error.message}`);
      return null;
    }
  }
  
  async extractBambooHRJobs(page, url) {
    try {
      const pageContent = await page.content();
      const $ = cheerio.load(pageContent);
      
      const jobsData = this.extractJobsFromCheerio($, url);
      
      if (jobsData.links.length > 0) {
        config.smartLog('win', `Extracted ${jobsData.links.length} jobs from main page`);
        return {
          url,
          title: jobsData.title || 'BambooHR Jobs',
          text: jobsData.text,
          links: jobsData.links,
          scrapedAt: new Date().toISOString(),
          method: this.name + '-direct',
          detectedPlatform: 'BambooHR'
        };
      }
      
      return null;
    } catch (error) {
      config.smartLog('fail', `Error extracting jobs from page: ${error.message}`);
      return null;
    }
  }
  
  extractJobsFromCheerio($, sourceUrl) {
    const jobs = [];
    const seenUrls = new Set();
    
    config.smartLog('steps', `Looking for BambooHR jobs with selectors`);
    
    const dict = this.getDictionary();
    const jobSelectors = dict.jobListingSelectors;
    const bambooSpecificSelectors = [
      '.BambooHR-ATS-Jobs-Item',
      '.BambooHR-ATS-Jobs-List li',
      '.BambooHR-ATS-Department-List li',
      '.bamboo-ats-job',
      '.bamboohr-jobs .job',
      '[data-bamboo-job]',
      'li:has(a[href*="bamboohr.com/careers"])',
      'ul[class*="jobs"] li',
      'ul[class*="ATS"] li'
    ];
    
    const allSelectors = [...jobSelectors, ...bambooSpecificSelectors];
    
    for (const selector of allSelectors) {
      try {
        const elements = $(selector);
        config.smartLog('steps', `Found ${elements.length} elements with selector: ${selector}`);
        
        elements.each((i, element) => {
          const $element = $(element);
          const link = $element.find('a').first();
          
          if (link.length > 0) {
            let href = link.attr('href');
            const title = link.text().trim();
            
            if (href && title && title.length > 3) {
              href = this.normalizeUrl(href, sourceUrl);
              
              if (href && !seenUrls.has(href)) {
                seenUrls.add(href);
                
                const locationElement = $element.find('.BambooHR-ATS-Location, .bamboo-location, [class*="location"]');
                const location = locationElement.length > 0 ? locationElement.text().trim() : '';
                
                const department = $element.closest('[id*="department"]').find('.BambooHR-ATS-Department-Header').text().trim();
                
                jobs.push({
                  url: href,
                  title: title,
                  text: `${title}${location ? ' - ' + location : ''}${department ? ' (' + department + ')' : ''}`,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.95,
                  source: 'bamboohr',
                  location: location,
                  department: department
                });
                
                config.smartLog('win', `Found job: "${title}" at ${location || 'Unknown location'}`);
              }
            }
          }
        });
      } catch (error) {
        config.smartLog('fail', `Error with selector ${selector}: ${error.message}`);
      }
    }
    
    const jobUrlPatterns = dict.jobURLPatterns;
    const bambooLinkSelectors = [
      '.BambooHR-ATS-Jobs-Item a',
      '.BambooHR-ATS-Jobs-List a',
      'a[href*="bamboohr.com/careers"]',
      'a[href*=".bamboohr.com/careers"]',
      '.bamboo-ats-job a',
      '.bamboohr-jobs a'
    ];
    
    for (const linkSelector of bambooLinkSelectors) {
      try {
        const links = $(linkSelector);
        config.smartLog('steps', `Found ${links.length} direct job links with selector: ${linkSelector}`);
        
        links.each((i, element) => {
          const $link = $(element);
          let href = $link.attr('href');
          const title = $link.text().trim();
          
          if (href && title && title.length > 3) {
            href = this.normalizeUrl(href, sourceUrl);
            
            if (href && !seenUrls.has(href)) {
              const isJobUrl = jobUrlPatterns.some(pattern => pattern.test(href));
              const isJobText = this.isJobRelatedText(title);
              
              if (isJobUrl || isJobText) {
                seenUrls.add(href);
                
                const parentElement = $link.closest('li, tr, div');
                const location = parentElement.find('[class*="location"], [class*="Location"]').text().trim();
                
                jobs.push({
                  url: href,
                  title: title,
                  text: `${title}${location ? ' - ' + location : ''}`,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.9,
                  source: 'bamboohr-direct',
                  location: location
                });
                
                config.smartLog('win', `Found direct job link: "${title}"`);
              }
            }
          }
        });
      } catch (error) {
        config.smartLog('fail', `Error with link selector ${linkSelector}: ${error.message}`);
      }
    }
    
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const title = $('title').text() || $('h1').first().text() || 'BambooHR Careers';
    
    config.smartLog('win', `Total jobs found: ${jobs.length}`);
    
    return {
      title: title,
      text: bodyText,
      links: jobs
    };
  }
  
  isJobRelatedText(text) {
    const lowerText = text.toLowerCase();
    const dict = this.getDictionary();
    const jobTerms = dict.jobTerms;
    
    return jobTerms.some(term => lowerText.includes(term.toLowerCase()));
  }

  normalizeUrl(href, sourceUrl) {
    try {
      if (href.startsWith('//')) {
        return 'https:' + href;
      } else if (href.startsWith('/')) {
        const urlObj = new URL(sourceUrl);
        return `${urlObj.protocol}//${urlObj.host}${href}`;
      } else if (href.startsWith('http')) {
        return href;
      }
      return null;
    } catch (e) {
      config.smartLog('fail', `Error normalizing URL ${href}: ${e.message}`);
      return null;
    }
  }
  
  mergeResults(directResults, iframeResults) {
    if (!directResults && !iframeResults) return null;
    if (!directResults) return iframeResults;
    if (!iframeResults) return directResults;
    
    const seenUrls = new Set();
    const mergedLinks = [];
    
    [...directResults.links, ...iframeResults.links].forEach(link => {
      if (!seenUrls.has(link.url)) {
        seenUrls.add(link.url);
        mergedLinks.push(link);
      }
    });
    
    return {
      url: directResults.url,
      title: directResults.title,
      text: directResults.text + ' ' + iframeResults.text,
      links: mergedLinks,
      scrapedAt: new Date().toISOString(),
      method: this.name + '-combined',
      detectedPlatform: 'BambooHR',
      directJobsCount: directResults.links.length,
      iframeJobsCount: iframeResults.links.length,
      totalJobsCount: mergedLinks.length
    };
  }
  
  isResultValid(result) {
    if (!super.isResultValid(result)) return false;
    
    const hasValidJobs = result.links && result.links.length > 0;
    const hasValidText = result.text && result.text.length > 50;
    const hasNoTemplates = !this.hasUnrenderedTemplates(result.text);
    
    const jobLinksCount = result.links ? result.links.filter(link => 
      link.isJobPosting === true || 
      (link.url && link.url.includes('career')) ||
      (link.url && link.url.includes('bamboohr.com'))
    ).length : 0;
    
    config.smartLog('steps', `Validation - Jobs: ${hasValidJobs} (${jobLinksCount}), Text: ${hasValidText} (${result.text?.length}), No templates: ${hasNoTemplates}`);
    
    return hasValidJobs && hasValidText && hasNoTemplates && jobLinksCount > 0;
  }
  
  hasUnrenderedTemplates(text) {
    if (!text) return false;
    
    const templatePatterns = [
      /\{\{\s*department\s*\}\}/i,
      /\{\{\s*job\.jobTitle\s*\}\}/i,
      /\{\{\s*job\.location\s*\}\}/i,
      /\{\{\s*[^}]+\}\}/
    ];
    
    const hasTemplates = templatePatterns.some(pattern => pattern.test(text));
    
    if (hasTemplates) {
      config.smartLog('fail', `Found unrendered templates in text`);
    }
    
    return hasTemplates;
  }
}

module.exports = BambooHRStep;