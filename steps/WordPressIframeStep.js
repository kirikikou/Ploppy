const { chromium } = require('playwright');
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const config = require('../../config');
const path = require('path');
const fs = require('fs').promises;

class WordPressIframeStep extends BaseScraperStep {
  constructor() {
    super('wordpress-iframe', 4);
  }
  
  async isApplicable(url, context = {}) {
    if (context.detectedPlatform !== 'WordPress') return false;
    
    if (context.previousStepResult) {
      const prevResult = context.previousStepResult;
      const hasIframeContent = prevResult.text && 
        (prevResult.text.includes('iframe') || prevResult.text.includes('embed'));
      const hasLimitedResults = !prevResult.links || prevResult.links.filter(l => l.isJobPosting).length === 0;
      
      return hasIframeContent || hasLimitedResults;
    }
    
    return true;
  }
  
  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ${this.name} for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);
    
    let browser, context, page;
    let result = null;
    let scrapingError = null;
    
    try {
      browser = await chromium.launch({
        headless: true,
        args: [...config.playwrightArgs, '--disable-web-security', '--disable-features=VizDisplayCompositor']
      });
      
      context = await browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        locale: 'en-US'
      });
      
      page = await context.newPage();
      
      await page.goto(url, { 
        waitUntil: 'networkidle', 
        timeout: 30000 
      });
      
      await this.handleWordPressCookies(page);
      await this.waitForIframes(page);
      
      const content = await this.extractContentWithIframes(page, url);
      
      if (this.isValidWordPressContent(content)) {
        config.smartLog('win', `Successfully extracted content from ${url}`);
        result = content;
      } else {
        config.smartLog('fail', `Invalid content produced`);
        scrapingError = new Error('Invalid content produced');
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
      
      return result;
      
    } catch (error) {
      config.smartLog('fail', `Error: ${error.message}`);
      scrapingError = error;
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
  
  async handleWordPressCookies(page) {
    const cookieSelectors = this.getCookieSelectors();
    
    for (const selector of cookieSelectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          await randomDelay(1000, 2000);
          config.smartLog('steps', `Clicked cookie button: ${selector}`);
          break;
        }
      } catch (e) {}
    }
  }
  
  async waitForIframes(page) {
    config.smartLog('steps', `Waiting for iframes to load`);
    
    try {
      await page.waitForSelector('iframe', { timeout: 10000 });
      await randomDelay(3000, 5000);
    } catch (e) {
      config.smartLog('steps', `No iframes found or timeout reached`);
    }
  }
  
  async extractContentWithIframes(page, url) {
    const result = {
      title: await page.title(),
      text: '',
      links: []
    };
    
    result.text = await this.extractMainPageContent(page);
    result.links = await this.extractMainPageLinks(page);
    
    const extractedJobs = await this.extractMainPageJobs(page);
    config.smartLog('steps', `Extracted ${extractedJobs.length} jobs from main page`);
    
    const iframes = await page.$$('iframe');
    config.smartLog('steps', `Found ${iframes.length} iframes`);
    
    for (let i = 0; i < Math.min(iframes.length, 5); i++) {
      try {
        const iframeData = await this.processIframe(page, iframes[i], i);
        if (iframeData) {
          if (iframeData.content) {
            result.text += '\n\n' + iframeData.content;
          }
          if (iframeData.links && iframeData.links.length > 0) {
            result.links.push(...iframeData.links);
          }
        }
      } catch (error) {
        config.smartLog('fail', `Error processing iframe ${i}: ${error.message}`);
      }
    }
    
    if (extractedJobs.length > 0) {
      const jobsText = extractedJobs.map(job => 
        `${job.title} ${job.location} ${job.department} ${job.description || ''}`
      ).join(' ');
      result.text += '\n\n' + jobsText;
    }
    
    result.links = this.deduplicateLinks(result.links);
    
    return {
      url,
      ...result,
      scrapedAt: new Date().toISOString(),
      method: this.name,
      platform: 'WordPress',
      detectedPlatform: 'WordPress'
    };
  }
  
  async extractMainPageContent(page) {
    const contentSelectors = [
      'main', 'article', '#main', '#content',
      '.main-content', '.primary-content', '.content-area',
      '[role="main"]', '[role="article"]',
      '.entry-content', '.post-content', '.page-content',
      '.content', '.main-content', '.primary-content'
    ];
    
    return await page.evaluate((selectors) => {
      for (const selector of selectors) {
        const mainContent = document.querySelector(selector);
        if (mainContent) {
          const clone = mainContent.cloneNode(true);
          clone.querySelectorAll('script, style, iframe').forEach(el => el.remove());
          return clone.innerText || clone.textContent || '';
        }
      }
      
      const bodyClone = document.body.cloneNode(true);
      bodyClone.querySelectorAll('script, style, nav, footer, iframe').forEach(el => el.remove());
      return bodyClone.innerText || bodyClone.textContent || '';
    }, contentSelectors);
  }
  
  async extractMainPageJobs(page) {
    const jobSelectors = this.getJobListingSelectors();
    const jobTerms = this.getJobTerms();
    
    return await page.evaluate((args) => {
      const { selectors, jobTerms } = args;
      const jobs = [];
      
      const isValidJobTitle = (title) => {
        if (!title || title.length < 3 || title.length > 100) return false;
        
        const lowerTitle = title.toLowerCase().trim();
        
        const hasJobTerms = jobTerms.some(term => 
          lowerTitle.includes(term.toLowerCase())
        );
        
        const hasValidStructure = /^[A-Z][a-zA-Z\s&\-().,\/]+$/.test(title) && 
                                 title.split(' ').length >= 1 && 
                                 title.split(' ').length <= 8;
        
        return hasValidStructure || hasJobTerms;
      };
      
      selectors.forEach(selector => {
        const jobElements = document.querySelectorAll(selector);
        jobElements.forEach(job => {
          const titleElement = job.querySelector('h1, h2, h3, h4, h5, h6, .title, .job-title, [class*="title"]');
          const locationElement = job.querySelector('.location, .job-location, .city, [class*="location"]');
          const departmentElement = job.querySelector('.department, .team, .category, [class*="department"]');
          const linkElement = job.querySelector('a[href]');
          
          if (titleElement && titleElement.textContent.trim() && isValidJobTitle(titleElement.textContent.trim())) {
            const title = titleElement.textContent.trim();
            
            jobs.push({
              title: title,
              location: locationElement ? locationElement.textContent.trim() : '',
              department: departmentElement ? departmentElement.textContent.trim() : '',
              url: linkElement ? linkElement.href : '',
              description: job.textContent.substring(0, 300).trim()
            });
          }
        });
      });
      
      return jobs;
    }, { selectors: jobSelectors, jobTerms });
  }
  
  async extractMainPageLinks(page) {
    const jobTerms = this.getJobTerms();
    const jobSelectors = this.getJobListingSelectors();
    
    return await page.evaluate((args) => {
      const { selectors, terms } = args;
      const links = [];
      const processedUrls = new Set();
      
      const isValidJobTitle = (title) => {
        if (!title || title.length < 3 || title.length > 100) return false;
        
        const lowerTitle = title.toLowerCase().trim();
        
        const hasJobTerms = terms.some(term => 
          lowerTitle.includes(term.toLowerCase())
        );
        
        const hasValidStructure = /^[A-Z][a-zA-Z\s&\-().,\/]+$/.test(title) && 
                                 title.split(' ').length >= 1 && 
                                 title.split(' ').length <= 8;
        
        return hasValidStructure || hasJobTerms;
      };
      
      selectors.forEach(selector => {
        const jobElements = document.querySelectorAll(selector);
        jobElements.forEach(job => {
          const titleElement = job.querySelector('h1, h2, h3, h4, h5, h6, .title, .job-title, [class*="title"]');
          const linkElement = job.querySelector('a[href]');
          
          if (titleElement && titleElement.textContent.trim() && linkElement && isValidJobTitle(titleElement.textContent.trim())) {
            const title = titleElement.textContent.trim();
            const jobUrl = linkElement.href;
            
            if (!processedUrls.has(jobUrl)) {
              processedUrls.add(jobUrl);
              
              links.push({
                url: jobUrl,
                text: title,
                isJobPosting: true,
                matchedJobTitle: title
              });
            }
          }
        });
      });
      
      document.querySelectorAll('a[href]').forEach(link => {
        const href = link.href;
        const text = link.textContent.trim();
        
        if (href && text && !href.startsWith('javascript:') && !processedUrls.has(href)) {
          const isJobRelated = terms.some(term => 
            href.toLowerCase().includes(term) || text.toLowerCase().includes(term)
          );
          
          if (isJobRelated && isValidJobTitle(text)) {
            links.push({ 
              url: href, 
              text: text,
              isJobPosting: isJobRelated,
              matchedJobTitle: isJobRelated ? text : undefined
            });
            processedUrls.add(href);
          }
        }
      });
      
      return links;
    }, { selectors: jobSelectors, terms: jobTerms });
  }
    
  async processIframe(page, iframe, index) {
    try {
      const src = await iframe.getAttribute('src');
      if (!src || src.startsWith('javascript:') || src.startsWith('data:')) {
        return null;
      }
      
      config.smartLog('steps', `Processing iframe ${index}: ${src}`);
      
      const iframeData = {
        src: src,
        content: '',
        links: [],
        platform: this.detectIframePlatform(src)
      };
      
      try {
        const frame = await iframe.contentFrame();
        if (!frame) {
          config.smartLog('fail', `Could not access iframe content: ${src}`);
          return iframeData;
        }
        
        await frame.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await randomDelay(2000, 3000);
        
        iframeData.content = await this.extractIframeText(frame);
        iframeData.links = await this.extractIframeLinks(frame);
        
        await this.handleIframeInteractions(frame, iframeData.platform);
        
        const additionalLinks = await this.extractIframeLinks(frame);
        if (additionalLinks.length > iframeData.links.length) {
          iframeData.links = additionalLinks;
        }
        
      } catch (error) {
        config.smartLog('fail', `Error accessing iframe content: ${error.message}`);
      }
      
      return iframeData;
      
    } catch (error) {
      config.smartLog('fail', `Error processing iframe ${index}: ${error.message}`);
      return null;
    }
  }
  
  detectIframePlatform(src) {
    const lowerSrc = src.toLowerCase();
    const knownJobPlatforms = this.getKnownJobPlatforms();
    
    for (const platform of knownJobPlatforms) {
      if (platform.patterns && platform.patterns.some(pattern => lowerSrc.includes(pattern.toLowerCase()))) {
        return platform.name;
      }
    }
    
    return 'unknown';
  }
  
  async extractIframeText(frame) {
    try {
      return await frame.evaluate(() => {
        const elementsToRemove = document.querySelectorAll('script, style, nav, footer');
        elementsToRemove.forEach(el => el.remove());
        return document.body.innerText || document.body.textContent || '';
      });
    } catch (error) {
      return '';
    }
  }
  
  async extractIframeLinks(frame) {
    const jobTerms = this.getJobTerms();
    const jobSelectors = this.getJobListingSelectors();
    
    try {
      return await frame.evaluate((args) => {
        const { selectors, terms } = args;
        const links = [];
        const processedUrls = new Set();
        
        const isValidJobTitle = (title) => {
          if (!title || title.length < 3 || title.length > 100) return false;
          
          const lowerTitle = title.toLowerCase().trim();
          
          const hasJobTerms = terms.some(term => 
            lowerTitle.includes(term.toLowerCase())
          );
          
          const hasValidStructure = /^[A-Z][a-zA-Z\s&\-().,\/]+$/.test(title) && 
                                   title.split(' ').length >= 1 && 
                                   title.split(' ').length <= 8;
          
          return hasValidStructure || hasJobTerms;
        };
        
        selectors.forEach(selector => {
          const jobElements = document.querySelectorAll(selector);
          jobElements.forEach(job => {
            const titleElement = job.querySelector('h1, h2, h3, h4, h5, h6, .title, [class*="title"], a');
            const linkElement = job.querySelector('a[href]');
            
            if (titleElement && linkElement && isValidJobTitle(titleElement.textContent.trim())) {
              const title = titleElement.textContent.trim();
              const href = linkElement.href;
              
              if (!processedUrls.has(href)) {
                processedUrls.add(href);
                links.push({
                  url: href,
                  text: title,
                  isJobPosting: true,
                  matchedJobTitle: title,
                  source: 'iframe'
                });
              }
            }
          });
        });
        
        document.querySelectorAll('a[href]').forEach(link => {
          const href = link.href;
          const text = link.textContent.trim();
          
          if (href && text && !href.startsWith('javascript:') && !processedUrls.has(href)) {
            const isJobRelated = terms.some(term => 
              href.toLowerCase().includes(term) || text.toLowerCase().includes(term)
            );
            
            if (isJobRelated && isValidJobTitle(text)) {
              links.push({
                url: href,
                text: text,
                isJobPosting: isJobRelated,
                matchedJobTitle: isJobRelated ? text : undefined,
                source: 'iframe'
              });
              processedUrls.add(href);
            }
          }
        });
        
        return links;
      }, { selectors: jobSelectors, terms: jobTerms });
    } catch (error) {
      return [];
    }
  }
  
  async handleIframeInteractions(frame, platform) {
    try {
      await this.handleIframeCookies(frame);
      await this.handleIframeShowMore(frame);
      
    } catch (error) {
      config.smartLog('fail', `Error in iframe interactions: ${error.message}`);
    }
  }
  
  async handleIframeCookies(frame) {
    const cookieSelectors = this.getCookieSelectors();
    
    for (const selector of cookieSelectors) {
      try {
        const element = await frame.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          await randomDelay(1000, 2000);
          break;
        }
      } catch (e) {}
    }
  }
  
  async handleIframeShowMore(frame) {
    const showMoreSelectors = this.getShowMoreSelectors();
    const showMoreText = this.getShowMoreTextSelectors();
    
    for (const selector of showMoreSelectors) {
      try {
        const element = await frame.$(selector);
        if (element && await element.isVisible()) {
          const text = await element.textContent();
          const isValidShowMore = showMoreText.some(term => 
            text && text.toLowerCase().includes(term.toLowerCase())
          );
          
          if (isValidShowMore) {
            await element.click();
            await randomDelay(2000, 3000);
            config.smartLog('steps', `Clicked show more in iframe: ${text}`);
            break;
          }
        }
      } catch (e) {}
    }
  }
  
  deduplicateLinks(links) {
    const seen = new Set();
    return links.filter(link => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
  }
  
  isValidWordPressContent(content) {
    if (!content) return false;
    
    const hasContent = content.text && content.text.length > 50;
    const hasJobLinks = content.links && content.links.filter(l => l.isJobPosting).length > 0;
    
    config.smartLog('steps', `Content validation - Text: ${content.text?.length || 0} chars, Job Links: ${content.links?.filter(l => l.isJobPosting).length || 0}`);
    
    return hasContent || hasJobLinks;
  }
}

module.exports = WordPressIframeStep;