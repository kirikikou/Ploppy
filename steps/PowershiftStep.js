const { chromium } = require('playwright');
const cheerio = require('cheerio');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const { extractContentFromCheerio } = require('../helpers');
const config = require('../../config');

class PowershiftStep extends BaseScraperStep {
  constructor() {
    super('powershift-step', 3);
    this.browser = null;
    this.platformConfig = null;
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
    config.smartLog('platform', `Checking applicability for ${url}`);
    
    if (context.options?.dictionary) {
      this.setDictionary(context.options.dictionary);
    }
    
    const detectedPlatformName = typeof context.detectedPlatform === 'string' ? context.detectedPlatform : context.detectedPlatform?.name;
    const optionsDetectedPlatformName = typeof context.options?.detectedPlatform === 'string' ? context.options.detectedPlatform : context.options?.detectedPlatform?.name;
    
    const isDetectedPlatform = detectedPlatformName === 'Powershift';
    const isDetectedInOptions = optionsDetectedPlatformName === 'Powershift';
    
    config.smartLog('platform', `Detection checks - Context platform: ${detectedPlatformName}, Options platform: ${optionsDetectedPlatformName}`);
    
    if (detectedPlatformName && detectedPlatformName !== 'Powershift') {
      config.smartLog('platform', `Not applicable - Different platform detected: ${detectedPlatformName}`);
      return false;
    }
    
    if (optionsDetectedPlatformName && optionsDetectedPlatformName !== 'Powershift') {
      config.smartLog('platform', `Not applicable - Different platform detected in options: ${optionsDetectedPlatformName}`);
      return false;
    }
    
    if (isDetectedPlatform || isDetectedInOptions) {
      config.smartLog('platform', `Applicable for ${url} - Powershift explicitly detected`);
      return true;
    }
    
    let htmlContent = context.htmlContent || context.html || '';
    
    if (htmlContent) {
      const hasPowershiftIndicators = this.checkForPowershiftIndicators(htmlContent);
      config.smartLog('platform', `HTML indicators from pre-fetched content: ${hasPowershiftIndicators}`);
      
      if (hasPowershiftIndicators) {
        config.smartLog('platform', `Applicable for ${url} - Powershift indicators found in HTML`);
        return true;
      }
    }
    
    if (!htmlContent && !detectedPlatformName) {
      try {
        config.smartLog('platform', `Fetching HTML to check Powershift applicability for ${url}`);
        
        const response = await axios.get(url, {
          timeout: 6000,
          maxRedirects: 2,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        
        htmlContent = response.data;
        const hasPowershiftIndicators = this.checkForPowershiftIndicators(htmlContent);
        
        if (hasPowershiftIndicators) {
          context.html = htmlContent;
          config.smartLog('platform', `Applicable for ${url} - Powershift indicators found in fetched HTML`);
          return true;
        }
        
      } catch (error) {
        config.smartLog('retry', `Could not fetch HTML for applicability check: ${error.message}`);
      }
    }
    
    config.smartLog('platform', `Not applicable for ${url} - No Powershift indicators found`);
    return false;
  }
  
  checkForPowershiftIndicators(htmlContent) {
    if (!htmlContent) return false;
    
    const htmlLower = htmlContent.toLowerCase();
    
    const fallbackIndicators = [
      'powered by powershift',
      'powershift.co.uk',
      'powershift-main.js',
      'powershift-scripts',
      'powershift.js',
      'block-bamboo-hr',
      'bamboo-app',
      'bamboohr-ats',
      'bamboo-datafeed'
    ];
    
    for (const indicator of fallbackIndicators) {
      if (htmlLower.includes(indicator)) {
        config.smartLog('platform', `Found fallback Powershift indicator: ${indicator}`);
        return true;
      }
    }
    
    const moderateIndicators = ['powershift', 'bamboo', 'bamboohr'];
    let moderateMatches = 0;
    const foundModerate = [];
    
    for (const indicator of moderateIndicators) {
      if (htmlLower.includes(indicator)) {
        moderateMatches++;
        foundModerate.push(indicator);
      }
    }
    
    if (moderateMatches >= 2) {
      config.smartLog('platform', `Found multiple moderate Powershift indicators: ${foundModerate.join(', ')}`);
      return true;
    }
    
    config.smartLog('platform', `Powershift indicators check - Strong: 0, Moderate: ${moderateMatches} - Not sufficient`);
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting Powershift specialized scraping for ${url}`);
    const startTime = Date.now();
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }

    let result = null;
    let scrapingError = null;
    let page = null;
    let context = null;
    
    try {
      await this.initialize();
      
      context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        bypassCSP: true
      });
      
      await context.route('**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf,eot}', route => route.abort());
      
      page = await context.newPage();
      
      try {
        config.smartLog('steps', `Navigating to ${url}`);
        await page.goto(url, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        
        config.smartLog('platform', `Page loaded, handling cookies and waiting for content`);
        await this.handleCookieConsent(page);
        
        await this.waitForPowershiftContent(page);
        
        config.smartLog('steps', `Processing embedded iframes (BambooHR, etc.)`);
        const iframeResults = await this.processEmbeddedIframes(page, url);
        
        config.smartLog('steps', `Extracting jobs from main page`);
        const directResults = await this.extractPowershiftJobs(page, url);
        
        const combinedResults = this.mergeResults(directResults, iframeResults);
        
        if (combinedResults && this.isResultValid(combinedResults)) {
          result = combinedResults;
          config.smartLog('win', `Successfully extracted ${result.links.length} jobs from Powershift site`);
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
        config.smartLog('fail', `Error in Powershift scraping: ${error.message}`);
        scrapingError = error;
      }
      
      return result;
    } catch (error) {
      config.smartLog('fail', `Critical error: ${error.message}`);
      scrapingError = error;
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  }
  
  async waitForPowershiftContent(page) {
    config.smartLog('platform', `Waiting for Powershift content to load...`);
    
    try {
      await page.waitForFunction(() => {
        const bambooJobItems = document.querySelectorAll('.BambooHR-ATS-Jobs-Item');
        const bambooBoard = document.querySelector('.BambooHR-ATS-board');
        
        if (bambooJobItems.length > 0 && bambooBoard) {
          const hasValidJobs = Array.from(bambooJobItems).some(item => {
            const link = item.querySelector('a');
            const text = link ? link.textContent.trim() : '';
            return text.length > 3 && !text.includes('{{') && link.href && link.href.includes('bamboohr.com');
          });
          
          console.log(`BambooHR jobs found: ${bambooJobItems.length}, Valid jobs: ${hasValidJobs}`);
          return hasValidJobs;
        }
        
        return false;
      }, { timeout: 8000 });
      
      config.smartLog('platform', `BambooHR content detected, brief stabilization wait...`);
      await randomDelay(1000, 2000);
      
    } catch (error) {
      config.smartLog('timeout', `Quick timeout, proceeding with current content: ${error.message}`);
      await randomDelay(2000, 3000);
    }
  }
  
  async handleCookieConsent(page) {
    try {
      const cookieSelectors = [
        'button[id*="accept"]', 'button[class*="accept"]', 
        'button[id*="cookie"]', 'button[class*="cookie"]',
        '[data-testid*="accept"]', '[data-testid*="cookie"]'
      ];
      
      const cookieTextPatterns = [
        'accept', 'agree', 'allow', 'continue', 'ok', 'got it',
        'accepter', 'autoriser', 'continuer', 'compris'
      ];
      
      for (const selector of cookieSelectors.slice(0, 10)) {
        try {
          const element = await page.$(selector);
          if (element && await element.isVisible()) {
            config.smartLog('platform', `Accepting cookies with: ${selector}`);
            await element.click();
            await randomDelay(500, 1000);
            return;
          }
        } catch (e) {}
      }
      
      const buttons = await page.$('button');
      for (const button of buttons.slice(0, 20)) {
        try {
          const text = await button.textContent();
          if (text && cookieTextPatterns.some(pattern => 
            text.toLowerCase().includes(pattern.toLowerCase())
          )) {
            config.smartLog('platform', `Accepting cookies with text: ${text}`);
            await button.click();
            await randomDelay(500, 1000);
            return;
          }
        } catch (e) {}
      }
      
    } catch (error) {
      config.smartLog('retry', `Cookie consent handling: ${error.message}`);
    }
  }
  
  async processEmbeddedIframes(page, url) {
    try {
      const frames = page.frames();
      const jobRelatedIframes = frames.filter(frame => {
        if (frame === page.mainFrame()) return false;
        const frameUrl = frame.url();
        
        if (!frameUrl) return false;
        
        const platformPatterns = ['bamboohr.com', 'powershift.co.uk', 'job', 'career', 'embed'];
        
        return platformPatterns.some(pattern => frameUrl.includes(pattern));
      });
      
      if (jobRelatedIframes.length === 0) {
        config.smartLog('platform', `No job-related iframes found`);
        return null;
      }
      
      config.smartLog('platform', `Processing ${jobRelatedIframes.length} job-related iframes`);
      
      let aggregatedText = '';
      let aggregatedLinks = [];
      
      for (const iframe of jobRelatedIframes) {
        try {
          config.smartLog('platform', `Processing iframe: ${iframe.url()}`);
          
          await iframe.waitForLoadState('domcontentloaded', { timeout: 10000 });
          await randomDelay(2000, 4000);
          
          const frameContent = await iframe.content();
          const $ = cheerio.load(frameContent);
          
          const frameJobs = this.extractJobsFromCheerio($, iframe.url());
          
          if (frameJobs.links.length > 0) {
            aggregatedText += ' ' + frameJobs.text;
            aggregatedLinks = [...aggregatedLinks, ...frameJobs.links];
            config.smartLog('win', `Extracted ${frameJobs.links.length} jobs from iframe: ${iframe.url()}`);
          }
          
        } catch (error) {
          config.smartLog('fail', `Error processing iframe: ${error.message}`);
        }
      }
      
      if (aggregatedLinks.length > 0) {
        return {
          url,
          title: 'Powershift Jobs (Embedded)',
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
  
  async extractPowershiftJobs(page, url) {
    try {
      const pageContent = await page.content();
      const $ = cheerio.load(pageContent);
      
      const jobsData = this.extractJobsFromCheerio($, url);
      
      if (jobsData.links.length > 0) {
        config.smartLog('win', `Extracted ${jobsData.links.length} jobs from main page`);
        return {
          url,
          title: jobsData.title || 'Powershift Jobs',
          text: jobsData.text,
          links: jobsData.links,
          scrapedAt: new Date().toISOString(),
          method: this.name + '-direct',
          detectedPlatform: 'Powershift'
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
    
    config.smartLog('steps', `Looking for Powershift jobs with selectors`);
    
    const prioritySelectors = [
      '.BambooHR-ATS-Jobs-Item',
      '.BambooHR-ATS-Jobs-List li'
    ];
    
    for (const selector of prioritySelectors) {
      try {
        const elements = $(selector);
        config.smartLog('steps', `Found ${elements.length} elements with selector: ${selector}`);
        
        elements.each((i, element) => {
          const $element = $(element);
          const link = $element.find('a').first();
          
          if (link.length > 0) {
            let href = link.attr('href');
            const title = link.text().trim();
            
            if (href && title && title.length > 3 && title.length < 200 && !title.includes('{{') && !title.includes('}}')) {
              href = this.normalizeUrl(href, sourceUrl);
              
              if (href && !seenUrls.has(href) && href.includes('bamboohr.com')) {
                seenUrls.add(href);
                
                const locationElement = $element.find('.BambooHR-ATS-Location, [class*="location"]');
                const location = locationElement.length > 0 ? locationElement.text().trim() : '';
                
                const departmentParent = $element.closest('.BambooHR-ATS-Department-Item');
                const departmentHeader = departmentParent.find('.BambooHR-ATS-Department-Header');
                const department = departmentHeader.length > 0 ? departmentHeader.text().trim() : '';
                
                jobs.push({
                  url: href,
                  title: title,
                  text: `${title}${location ? ' - ' + location : ''}${department ? ' (' + department + ')' : ''}`,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.95,
                  source: 'powershift-bamboo',
                  location: location,
                  department: department,
                  platform: 'BambooHR'
                });
                
                config.smartLog('win', `Found BambooHR job: "${title}" at ${location || 'Unknown location'} - ${href}`);
              }
            }
          }
        });
      } catch (error) {
        config.smartLog('fail', `Error with priority selector ${selector}: ${error.message}`);
      }
    }
    
    if (jobs.length === 0) {
      const jobListingSelectors = [
        '.job-listing', '.job-item', '.position', '.vacancy',
        '[class*="job"]', '[class*="position"]', '[class*="career"]',
        'li[class*="job"]', 'div[class*="job"]', '.employment',
        '.opening', '.opportunity', '[data-job]', '[data-position]'
      ];
      const fallbackSelectors = [
        '.block-bamboo-hr',
        '.bamboo-app',
        '#bamboo-app',
        '.BambooHR-ATS-board',
        ...jobListingSelectors.slice(0, 15)
      ];
      
      for (const selector of fallbackSelectors) {
        try {
          const elements = $(selector);
          config.smartLog('steps', `Found ${elements.length} elements with fallback selector: ${selector}`);
          
          elements.each((i, element) => {
            const $element = $(element);
            const link = $element.find('a').first();
            
            if (link.length > 0) {
              let href = link.attr('href');
              const title = link.text().trim();
              
              if (href && title && title.length > 3 && title.length < 200 && !title.includes('{{') && !title.includes('}}')) {
                href = this.normalizeUrl(href, sourceUrl);
                
                if (href && !seenUrls.has(href)) {
                  seenUrls.add(href);
                  
                  const confidence = href.includes('bamboohr.com') ? 0.95 : 0.8;
                  
                  jobs.push({
                    url: href,
                    title: title,
                    text: title,
                    isJobPosting: true,
                    linkType: 'job_posting',
                    confidence: confidence,
                    source: 'powershift',
                    platform: href.includes('bamboohr.com') ? 'BambooHR' : 'Powershift'
                  });
                  
                  config.smartLog('win', `Found fallback job: "${title}" - ${href}`);
                }
              }
            }
          });
          
          if (jobs.length > 0) break;
        } catch (error) {
          config.smartLog('fail', `Error with selector ${selector}: ${error.message}`);
        }
      }
    }
    
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const title = $('title').text() || $('h1').first().text() || 'Powershift Careers';
    
    config.smartLog('steps', `Total jobs found: ${jobs.length}`);
    
    return {
      title: title,
      text: bodyText,
      links: jobs
    };
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
      } else if (href.startsWith('#')) {
        return null;
      }
      return null;
    } catch (e) {
      config.smartLog('fail', `Error normalizing URL ${href}: ${e.message}`);
      return null;
    }
  }
  
  mergeResults(directResults, iframeResults) {
    if (!directResults && !iframeResults) return null;
    if (!iframeResults) return directResults;
    if (!directResults) return iframeResults;
    
    const allLinks = [...directResults.links];
    const seenUrls = new Set(directResults.links.map(link => link.url));
    
    iframeResults.links.forEach(link => {
      if (!seenUrls.has(link.url)) {
        allLinks.push(link);
        seenUrls.add(link.url);
      }
    });
    
    return {
      url: directResults.url,
      title: directResults.title || 'Powershift Jobs',
      text: (directResults.text + ' ' + iframeResults.text).trim(),
      links: allLinks,
      scrapedAt: new Date().toISOString(),
      method: this.name + '-combined',
      detectedPlatform: 'Powershift',
      totalJobsCount: allLinks.length
    };
  }
  
  isResultValid(result) {
    if (!result || typeof result !== 'object') {
      config.smartLog('fail', `Validation failed - No result object`);
      return false;
    }
    
    if (!result.links || !Array.isArray(result.links)) {
      config.smartLog('fail', `Validation failed - No links array`);
      return false;
    }
    
    const validJobLinks = result.links.filter(link => 
      link && 
      link.url && 
      link.title && 
      link.title.length > 3 &&
      (link.isJobPosting === true || link.url.includes('bamboohr.com') || link.url.includes('career') || link.url.includes('job'))
    );
    
    const hasValidJobs = validJobLinks.length > 0;
    const hasValidText = result.text && result.text.length > 30;
    const hasNoUnrenderedTemplates = !this.hasUnrenderedTemplates(result.text);
    
    config.smartLog('steps', `Validation results:`);
    config.smartLog('steps', `  - Valid jobs: ${hasValidJobs} (${validJobLinks.length}/${result.links.length})`);
    config.smartLog('steps', `  - Valid text: ${hasValidText} (${result.text?.length} chars)`);
    config.smartLog('steps', `  - No templates: ${hasNoUnrenderedTemplates}`);
    
    if (hasValidJobs && hasValidText && hasNoUnrenderedTemplates) {
      config.smartLog('win', `Validation PASSED - Result is valid`);
      return true;
    } else {
      config.smartLog('fail', `Validation FAILED`);
      if (!hasValidJobs) config.smartLog('fail', `  - Issue: No valid job links found`);
      if (!hasValidText) config.smartLog('fail', `  - Issue: Text too short or missing`);
      if (!hasNoUnrenderedTemplates) config.smartLog('fail', `  - Issue: Unrendered templates found`);
      return false;
    }
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
      /\$\{[^}]+\}/,
      /\[\[.*?\]\]/,
      /\{\{.*?\}\}/
    ];
    
    const hasTemplates = templatePatterns.some(pattern => pattern.test(text));
    
    if (hasTemplates) {
      config.smartLog('fail', `Found unrendered templates in text`);
    }
    
    return hasTemplates;
  }
}

module.exports = PowershiftStep;