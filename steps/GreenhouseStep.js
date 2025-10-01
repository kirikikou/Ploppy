const { chromium } = require('playwright');
const cheerio = require('cheerio');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const { extractContentFromCheerio } = require('../helpers');
const config = require('../../config');

class GreenhouseStep extends BaseScraperStep {
  constructor() {
    super('greenhouse-step', 2);
    this.browser = null;
    this.greenhousePlatform = null;
  }
  
  async initialize(page = null) {
    await super.initialize(page);
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
    
    const dict = this.getDictionary();
    const knownPlatforms = dict.knownJobPlatforms;
    this.greenhousePlatform = knownPlatforms.find(p => p.name === 'Greenhouse') || {
      name: 'Greenhouse',
      indicators: ['greenhouse-jobs', 'posting', 'opening', 'gh-', 'greenhouse-board'],
      patterns: ['greenhouse.io', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'api.greenhouse.io'],
      apiPatterns: ['/embed/job_board', '/api/job_board', '/v1/boards']
    };
    return this.browser;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async isApplicable(url, context = {}) {
    config.smartLog('platform', `Checking Greenhouse applicability for ${url}`);
    
    if (context.options && context.options.dictionary) {
      this.setDictionary(context.options.dictionary);
    }
    
    await this.initialize();
    
    const urlLower = url.toLowerCase();
    
    let isGreenhouseUrl = false;
    if (this.greenhousePlatform?.patterns) {
      isGreenhouseUrl = this.greenhousePlatform.patterns.some(pattern => 
        urlLower.includes(pattern.toLowerCase())
      );
    }
    
    const detectedPlatformName = typeof context.detectedPlatform === 'string' ? context.detectedPlatform : context.detectedPlatform?.name;
    const optionsDetectedPlatformName = typeof context.options?.detectedPlatform === 'string' ? context.options.detectedPlatform : context.options?.detectedPlatform?.name;
    
    const isDetectedPlatform = detectedPlatformName === 'Greenhouse';
    const isDetectedInOptions = optionsDetectedPlatformName === 'Greenhouse';
    
    config.smartLog('platform', `Detection checks - URL: ${isGreenhouseUrl}, Context: ${detectedPlatformName}, Options: ${optionsDetectedPlatformName}`);
    
    if (detectedPlatformName && detectedPlatformName !== 'Greenhouse') {
      config.smartLog('platform', `Not applicable - Different platform: ${detectedPlatformName}`);
      return false;
    }
    
    if (optionsDetectedPlatformName && optionsDetectedPlatformName !== 'Greenhouse') {
      config.smartLog('platform', `Not applicable - Different platform in options: ${optionsDetectedPlatformName}`);
      return false;
    }
    
    if (isGreenhouseUrl || isDetectedPlatform || isDetectedInOptions) {
      config.smartLog('platform', `Applicable - Greenhouse explicitly detected`);
      return true;
    }
    
    let htmlContent = context.htmlContent || context.html || '';
    
    if (htmlContent) {
      const hasGreenhouseIndicators = this.checkForGreenhouseIndicators(htmlContent);
      config.smartLog('platform', `HTML indicators from pre-fetched content: ${hasGreenhouseIndicators}`);
      
      if (hasGreenhouseIndicators) {
        if (this.hasConflictingPlatformIndicators(htmlContent)) {
          config.smartLog('platform', `Not applicable - Conflicting platform indicators`);
          return false;
        }
        
        config.smartLog('platform', `Applicable - Greenhouse indicators found in HTML`);
        return true;
      }
    }
    
    if (!htmlContent && !detectedPlatformName) {
      try {
        config.smartLog('platform', `Fetching HTML to check Greenhouse applicability`);
        
        const response = await axios.get(url, {
          timeout: 6000,
          maxRedirects: 2,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        
        htmlContent = response.data;
        
        if (this.hasConflictingPlatformIndicators(htmlContent)) {
          config.smartLog('platform', `Not applicable - Conflicting platform indicators in fetched HTML`);
          return false;
        }
        
        const hasGreenhouseIndicators = this.checkForGreenhouseIndicators(htmlContent);
        
        if (hasGreenhouseIndicators) {
          context.html = htmlContent;
          config.smartLog('platform', `Applicable - Greenhouse indicators found in fetched HTML`);
          return true;
        }
        
      } catch (error) {
        config.smartLog('fail', `Could not fetch HTML for applicability check: ${error.message}`);
      }
    }
    
    config.smartLog('platform', `Not applicable - No Greenhouse indicators found`);
    return false;
  }
  
  hasConflictingPlatformIndicators(htmlContent) {
    if (!htmlContent) return false;
    
    const htmlLower = htmlContent.toLowerCase();
    const dict = this.getDictionary();
    const knownPlatforms = dict.knownJobPlatforms;
    
    for (const platform of knownPlatforms) {
      if (platform.name === 'Greenhouse') continue;
      
      for (const indicator of platform.indicators || []) {
        if (htmlLower.includes(indicator.toLowerCase())) {
          config.smartLog('platform', `Found conflicting ${platform.name} indicator: ${indicator}`);
          return true;
        }
      }
    }
    
    return false;
  }
  
  checkForGreenhouseIndicators(htmlContent) {
    if (!htmlContent) return false;
    
    const htmlLower = htmlContent.toLowerCase();
    
    if (this.greenhousePlatform?.indicators) {
      let matches = 0;
      for (const indicator of this.greenhousePlatform.indicators) {
        if (htmlLower.includes(indicator.toLowerCase())) {
          matches++;
          config.smartLog('platform', `Found Greenhouse indicator: ${indicator}`);
        }
      }
      
      if (matches >= 1) {
        config.smartLog('platform', `Found ${matches} Greenhouse indicators`);
        return true;
      }
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting Greenhouse specialized scraping for ${url}`);
    const startTime = Date.now();
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('steps', `Dictionary initialized successfully`);
    
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
      let result = null;
      let scrapingError = null;
      
      try {
        config.smartLog('steps', `Navigating to ${url}`);
        await page.goto(url, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        
        config.smartLog('steps', `Page loaded, handling cookies and waiting for content`);
        await this.handleCookieConsent(page);
        
        await this.waitForGreenhouseContent(page);
        
        config.smartLog('steps', `Processing Greenhouse iframes`);
        const iframeResults = await this.processGreenhouseIframes(page, url);
        
        config.smartLog('steps', `Extracting jobs from main page`);
        const directResults = await this.extractGreenhouseJobs(page, url);
        
        config.smartLog('steps', `Trying API endpoint discovery`);
        const apiResults = await this.tryApiEndpoints(page, url);
        
        const combinedResults = this.mergeMultipleResults(directResults, iframeResults, apiResults);
        
        if (combinedResults && this.isResultValid(combinedResults)) {
          result = combinedResults;
          config.smartLog('win', `Successfully extracted ${result.links.length} jobs from Greenhouse`);
        } else {
          config.smartLog('fail', `No valid results found`);
          scrapingError = new Error('No valid results found');
        }
        
        if (config.shouldExportDebug(result, scrapingError, 'greenhouse-step')) {
          const debugPromises = [
            page.screenshot({ fullPage: true }).then(screenshot => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `greenhouse-FAIL-${new URL(url).hostname}-${Date.now()}.png`), 
                screenshot
              )
            ).catch(() => {}),
            page.content().then(html => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `greenhouse-FAIL-${new URL(url).hostname}-${Date.now()}.html`), 
                html
              )
            ).catch(() => {})
          ];
          await Promise.all(debugPromises).catch(() => {});
        }
        
      } catch (error) {
        config.smartLog('fail', `Error in Greenhouse scraping: ${error.message}`);
        scrapingError = error;
      } finally {
        await page.close();
        await context.close();
      }
      
      return result;
    } catch (error) {
      config.smartLog('fail', `Critical error: ${error.message}`);
      return null;
    }
  }
  
  async waitForGreenhouseContent(page) {
    config.smartLog('steps', `Waiting for Greenhouse content to load...`);
    
    const universalJobSelectors = this.getJobListingSelectors();
    
    try {
      await page.waitForFunction((selectors, greenhouse) => {
        const jobElements = document.querySelectorAll(selectors.join(', '));
        const hasJobContent = Array.from(jobElements).some(el => {
          const text = el.textContent || '';
          return text.length > 10 && !text.includes('{{') && !text.includes('}}');
        });
        
        const hasGreenhouseMarkers = greenhouse && greenhouse.indicators ? 
          greenhouse.indicators.some(indicator => 
            document.body.innerHTML.toLowerCase().includes(indicator.toLowerCase())
          ) : false;
        
        return hasJobContent || jobElements.length > 0 || hasGreenhouseMarkers;
      }, universalJobSelectors, this.greenhousePlatform, { timeout: 15000 });
      
      config.smartLog('steps', `Greenhouse content detected, waiting for stabilization...`);
      await randomDelay(3000, 5000);
      
    } catch (error) {
      config.smartLog('timeout', `Timeout waiting for Greenhouse content, proceeding anyway: ${error.message}`);
      await randomDelay(5000, 8000);
    }
    
    try {
      await page.evaluate((greenhouse) => {
        if (!greenhouse || !greenhouse.indicators) return Promise.resolve();
        
        const scripts = document.querySelectorAll('script');
        let greenhouseScriptFound = false;
        
        for (const script of scripts) {
          const src = script.src || '';
          const content = script.textContent || '';
          
          if (greenhouse.indicators.some(ind => 
            src.toLowerCase().includes(ind.toLowerCase()) || 
            content.toLowerCase().includes(ind.toLowerCase())
          )) {
            greenhouseScriptFound = true;
            break;
          }
        }
        
        if (greenhouseScriptFound) {
          return new Promise(resolve => setTimeout(resolve, 4000));
        }
        
        return Promise.resolve();
      }, this.greenhousePlatform);
    } catch (error) {
      config.smartLog('fail', `Error waiting for scripts: ${error.message}`);
    }
    
    const greenhouseSpecificSelectors = this.greenhousePlatform?.indicators?.filter(ind => 
      ind.startsWith('#') || ind.startsWith('.')
    ) || [];
    
    if (greenhouseSpecificSelectors.length > 0) {
      try {
        await page.waitForSelector(greenhouseSpecificSelectors.join(', '), { timeout: 8000 });
        config.smartLog('steps', `Found specific Greenhouse elements`);
      } catch (error) {
        config.smartLog('steps', `Specific Greenhouse elements not found, continuing`);
      }
    }
  }
  
  async handleCookieConsent(page) {
    try {
      const cookieSelectors = this.getCookieSelectors();
      const cookieTextSelectors = this.getCookieTextSelectors();
      
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
      
      const buttons = await page.$$('button, a[role="button"], [role="button"]');
      for (const button of buttons) {
        try {
          const text = await button.textContent();
          if (text && cookieTextSelectors.some(textPattern => 
            text.toLowerCase().includes(textPattern.toLowerCase())
          )) {
            config.smartLog('steps', `Accepting cookies by text: ${text}`);
            await button.click();
            await randomDelay(1000, 2000);
            break;
          }
        } catch (e) {}
      }
    } catch (error) {
      config.smartLog('fail', `Cookie consent handling failed: ${error.message}`);
    }
  }
  
  async processGreenhouseIframes(page, url) {
    try {
      const frames = page.frames();
      const greenhouseIframes = frames.filter(frame => {
        if (frame === page.mainFrame()) return false;
        const frameUrl = frame.url();
        return frameUrl && this.greenhousePlatform?.patterns && 
               this.greenhousePlatform.patterns.some(pattern => frameUrl.includes(pattern));
      });
      
      if (greenhouseIframes.length === 0) {
        config.smartLog('steps', `No Greenhouse iframes found`);
        return null;
      }
      
      config.smartLog('steps', `Processing ${greenhouseIframes.length} Greenhouse iframes`);
      
      let aggregatedText = '';
      let aggregatedLinks = [];
      
      for (const iframe of greenhouseIframes) {
        try {
          config.smartLog('steps', `Processing iframe: ${iframe.url()}`);
          
          await iframe.waitForLoadState('domcontentloaded', { timeout: 10000 });
          await randomDelay(2000, 4000);
          
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
          title: 'Greenhouse Jobs (Iframe)',
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
  
  async extractGreenhouseJobs(page, url) {
    try {
      const pageContent = await page.content();
      const $ = cheerio.load(pageContent);
      
      const jobsData = this.extractJobsFromCheerio($, url);
      
      if (jobsData.links.length > 0) {
        config.smartLog('win', `Extracted ${jobsData.links.length} jobs from main page`);
        return {
          url,
          title: jobsData.title || 'Greenhouse Jobs',
          text: jobsData.text,
          links: jobsData.links,
          scrapedAt: new Date().toISOString(),
          method: this.name + '-direct',
          detectedPlatform: 'Greenhouse'
        };
      }
      
      return null;
    } catch (error) {
      config.smartLog('fail', `Error extracting jobs from page: ${error.message}`);
      return null;
    }
  }
  
  async tryApiEndpoints(page, url) {
    try {
      config.smartLog('steps', `Looking for Greenhouse API endpoints`);
      
      if (this.greenhousePlatform?.apiPatterns) {
        const apiInfo = await page.evaluate((apiPatterns) => {
          const scripts = document.querySelectorAll('script');
          const data = { companyId: null, boardToken: null, apiEndpoints: [] };
          
          for (const script of scripts) {
            const text = script.textContent || '';
            
            const companyMatch = text.match(/company[_-]?id['":]?\s*['":]?\s*['"]?(\w+)['"]?/i);
            if (companyMatch) data.companyId = companyMatch[1];
            
            const tokenMatch = text.match(/board[_-]?token['":]?\s*['":]?\s*['"]?(\w+)['"]?/i);
            if (tokenMatch) data.boardToken = tokenMatch[1];
            
            for (const pattern of apiPatterns) {
              try {
                const escapedPattern = typeof pattern === 'string' ? 
                  pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 
                  pattern.toString().slice(1, -1);
                const regex = new RegExp(`['"]?(https?://[^'"]*${escapedPattern}[^'"]*?)['"]?`, 'gi');
                const matches = text.match(regex);
                if (matches) data.apiEndpoints.push(...matches.map(m => m.replace(/['"]/g, '')));
              } catch (e) {
                console.log(`Error processing API pattern: ${pattern}`);
              }
            }
          }
          
          return data;
        }, this.greenhousePlatform.apiPatterns);
        
        if (apiInfo.companyId || apiInfo.boardToken || apiInfo.apiEndpoints.length > 0) {
          config.smartLog('steps', `Found API info`, apiInfo);
          
          const possibleApiUrls = [
            ...apiInfo.apiEndpoints,
            apiInfo.boardToken ? `https://boards.greenhouse.io/embed/job_board?token=${apiInfo.boardToken}` : null,
            apiInfo.companyId ? `https://api.greenhouse.io/v1/boards/${apiInfo.companyId}/jobs` : null
          ].filter(Boolean);
          
          for (const apiUrl of possibleApiUrls) {
            try {
              const response = await page.evaluate(async (url) => {
                const resp = await fetch(url);
                const contentType = resp.headers.get('content-type');
                
                if (contentType && contentType.includes('json')) {
                  return { type: 'json', data: await resp.json() };
                } else {
                  return { type: 'html', data: await resp.text() };
                }
              }, apiUrl);
              
              if (response.data) {
                return this.formatJobsFromApiResponse(response, url);
              }
            } catch (e) {
              config.smartLog('fail', `API endpoint failed: ${apiUrl}`);
            }
          }
        }
      }
      
      return null;
    } catch (error) {
      config.smartLog('fail', `Error in API discovery: ${error.message}`);
      return null;
    }
  }
  
  extractJobsFromCheerio($, sourceUrl) {
    const jobs = [];
    const seenUrls = new Set();
    
    const universalJobSelectors = this.getJobListingSelectors();
    const greenhouseSpecificSelectors = this.greenhousePlatform?.indicators?.filter(ind => 
      ind.startsWith('.') || ind.startsWith('#') || ind.includes('[')
    ) || [];
    
    const allSelectors = [...universalJobSelectors, ...greenhouseSpecificSelectors];
    
    config.smartLog('steps', `Looking for Greenhouse jobs with ${allSelectors.length} selectors`);
    
    for (const selector of allSelectors) {
      try {
        const elements = $(selector);
        
        elements.each((i, element) => {
          const $element = $(element);
          let link = $element.find('a').first();
          
          if (link.length === 0 && $element.is('a')) {
            link = $element;
          }
          
          if (link.length > 0) {
            let href = link.attr('href');
            const title = link.text().trim();
            
            if (href && title && title.length > 3 && title.length < 200) {
              href = this.normalizeUrl(href, sourceUrl);
              
              if (href && !seenUrls.has(href)) {
                seenUrls.add(href);
                
                const locationElement = $element.find('.location, .job-location, [class*="location"]');
                const location = locationElement.length > 0 ? locationElement.text().trim() : '';
                
                const departmentElement = $element.find('.department, .team, [class*="department"], [class*="team"]');
                const department = departmentElement.length > 0 ? departmentElement.text().trim() : '';
                
                const typeElement = $element.find('.job-type, .employment-type, [class*="type"]');
                const jobType = typeElement.length > 0 ? typeElement.text().trim() : '';
                
                jobs.push({
                  url: href,
                  title: title,
                  text: `${title}${location ? ' - ' + location : ''}${department ? ' (' + department + ')' : ''}${jobType ? ' [' + jobType + ']' : ''}`,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.95,
                  source: 'greenhouse',
                  location: location,
                  department: department,
                  jobType: jobType
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
    
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const title = $('title').text() || $('h1').first().text() || 'Greenhouse Careers';
    
    config.smartLog('win', `Total jobs found: ${jobs.length}`);
    
    return {
      title: title,
      text: bodyText,
      links: jobs
    };
  }
  
  formatJobsFromApiResponse(response, url) {
    let jobs = [];
    
    if (response.type === 'json' && response.data.jobs) {
      jobs = response.data.jobs.map(job => ({
        url: job.absolute_url || job.url || `${url}#job-${job.id}`,
        title: job.title || '',
        text: `${job.title || ''} - ${job.location?.name || ''}`.trim(),
        isJobPosting: true,
        confidence: 0.95,
        source: 'greenhouse-api',
        location: job.location?.name || '',
        department: job.departments?.[0]?.name || ''
      }));
    } else if (response.type === 'html') {
      const $ = cheerio.load(response.data);
      const frameJobs = this.extractJobsFromCheerio($, url);
      jobs = frameJobs.links;
    }
    
    if (jobs.length > 0) {
      return {
        url,
        title: 'Greenhouse Careers (API)',
        text: jobs.map(j => j.text).join('\n'),
        links: jobs,
        scrapedAt: new Date().toISOString(),
        method: this.name + '-api'
      };
    }
    
    return null;
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
        return `${sourceUrl}${href}`;
      }
      return null;
    } catch (e) {
      config.smartLog('fail', `Error normalizing URL ${href}: ${e.message}`);
      return null;
    }
  }
  
  mergeMultipleResults(directResults, iframeResults, apiResults) {
    const results = [directResults, iframeResults, apiResults].filter(Boolean);
    
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    
    const seenUrls = new Set();
    const mergedLinks = [];
    let mergedText = '';
    
    results.forEach(result => {
      mergedText += ' ' + result.text;
      result.links.forEach(link => {
        if (!seenUrls.has(link.url)) {
          seenUrls.add(link.url);
          mergedLinks.push(link);
        }
      });
    });
    
    const primaryResult = results[0];
    
    return {
      url: primaryResult.url,
      title: primaryResult.title,
      text: mergedText.trim(),
      links: mergedLinks,
      scrapedAt: new Date().toISOString(),
      method: this.name + '-combined',
      detectedPlatform: 'Greenhouse',
      directJobsCount: directResults?.links.length || 0,
      iframeJobsCount: iframeResults?.links.length || 0,
      apiJobsCount: apiResults?.links.length || 0,
      totalJobsCount: mergedLinks.length
    };
  }
  
  isResultValid(result) {
    if (!super.isResultValid(result)) return false;
    
    const hasValidJobs = result.links && result.links.length > 0;
    const hasValidText = result.text && result.text.length > 50;
    
    const jobLinksCount = result.links ? result.links.filter(link => 
      link.isJobPosting === true || 
      (link.url && (link.url.includes('career') || link.url.includes('job') || link.url.includes('greenhouse.io') || link.url.includes('#')))
    ).length : 0;
    
    if (jobLinksCount > 0) {
      const templateCount = this.countTemplateIndicators(result.text);
      const templateRatio = templateCount / (result.text.length / 100);
      
      const jobToTemplateRatio = jobLinksCount / Math.max(templateCount, 1);
      const hasReasonableContent = jobToTemplateRatio >= 0.5;
      
      config.smartLog('steps', `Smart validation - Jobs: ${jobLinksCount}, Templates: ${templateCount}, Job/Template ratio: ${jobToTemplateRatio.toFixed(2)}, Reasonable: ${hasReasonableContent}`);
      
      if (hasReasonableContent || templateRatio < 0.5) {
        config.smartLog('win', `Validation passed - Good content ratio or low template density`);
        return hasValidJobs && hasValidText;
      }
    }
    
    const hasMinimalTemplates = !this.hasTooManyUnrenderedTemplates(result.text);
    
    config.smartLog('steps', `Standard validation - Jobs: ${hasValidJobs} (${jobLinksCount}), Text: ${hasValidText} (${result.text?.length}), Minimal templates: ${hasMinimalTemplates}`);
    
    return hasValidJobs && hasValidText && hasMinimalTemplates && jobLinksCount > 0;
  }
  
  countTemplateIndicators(text) {
    if (!text) return 0;
    
    const dict = this.getDictionary();
    const templateIndicators = dict.templateIndicators || [
      '{{', '}}', '{%', '%}', '<%', '%>', '${', '}',
      'ng-repeat', 'ng-if', 'ng-for', 'v-for', 'v-if', 
      '*ngFor', '*ngIf', 'x-for', 'x-if',
      'data-bind', 'data-ng-', 'data-v-',
      'handlebars', 'mustache', 'twig', 'jinja',
      'template-', 'tmpl-', 'tpl-'
    ];
    
    let templateCount = 0;
    
    for (const indicator of templateIndicators) {
      const matches = text.split(indicator).length - 1;
      templateCount += matches;
    }
    
    return templateCount;
  }
  
  hasTooManyUnrenderedTemplates(text) {
    if (!text) return false;
    
    const dict = this.getDictionary();
    const templateIndicators = dict.templateIndicators || [
      '{{', '}}', '{%', '%}', '<%', '%>', '${', '}',
      'ng-repeat', 'ng-if', 'ng-for', 'v-for', 'v-if', 
      '*ngFor', '*ngIf', 'x-for', 'x-if',
      'data-bind', 'data-ng-', 'data-v-',
      'handlebars', 'mustache', 'twig', 'jinja',
      'template-', 'tmpl-', 'tpl-'
    ];
    
    let templateCount = 0;
    const totalLength = text.length;
    
    for (const indicator of templateIndicators) {
      const matches = text.split(indicator).length - 1;
      templateCount += matches;
    }
    
    const templateRatio = templateCount / (totalLength / 100);
    const tooManyTemplates = templateRatio > 1.0;
    
    if (tooManyTemplates) {
      config.smartLog('fail', `Too many template indicators: ${templateCount} in ${totalLength} chars (ratio: ${templateRatio.toFixed(2)})`);
    }
    
    return tooManyTemplates;
  }
}

module.exports = GreenhouseStep;