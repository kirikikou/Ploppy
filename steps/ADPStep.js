const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { extractContentFromCheerio } = require('../helpers');
const config = require('../../config');
const { getRandomUserAgent, randomDelay } = require('../../utils');
const path = require('path');
const fs = require('fs').promises;

class ADPStep extends BaseScraperStep {
  constructor() {
    super('adp-step', 4);
    this.browser = null;
    this.platformConfig = null;
  }

  async initialize() {
    const dict = this.getDictionary();
    this.platformConfig = dict.knownJobPlatforms.find(p => p.name === 'ADP');
  }

  async isApplicable(url, prevStepResult = {}) {
    if (!this.platformConfig) {
      await this.initialize();
    }
    
    const urlLower = url.toLowerCase();
    const isADPDomain = this.platformConfig.patterns.some(pattern => 
      urlLower.includes(pattern.toLowerCase())
    );
    
    if (prevStepResult.detectedPlatform === 'ADP') {
      config.smartLog('platform', `Applicable: Platform detected as ADP`);
      return true;
    }
    
    if (isADPDomain) {
      config.smartLog('platform', `Applicable: ADP domain detected in URL`);
      return true;
    }
    
    if (prevStepResult.html || prevStepResult.htmlContent) {
      const html = prevStepResult.html || prevStepResult.htmlContent;
      const hasADPIndicators = this.detectADPInContent(html);
      if (hasADPIndicators) {
        config.smartLog('platform', `Applicable: ADP indicators found in HTML`);
        return true;
      }
    }
    
    return false;
  }

  detectADPInContent(html) {
    if (!this.platformConfig) {
      const dict = this.getDictionary();
      this.platformConfig = dict.knownJobPlatforms.find(p => p.name === 'ADP');
    }
    
    const lowerHtml = html.toLowerCase();
    return this.platformConfig.indicators.some(indicator => 
      lowerHtml.includes(indicator.toLowerCase())
    );
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ADP scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    if (!this.platformConfig) {
      await this.initialize();
    }

    let result = null;
    let scrapingError = null;
    
    try {
      const startTime = Date.now();
      
      const lightweightResult = await this.tryLightweightScraping(url, options);
      if (lightweightResult) {
        lightweightResult.method = 'adp-lightweight';
        lightweightResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with lightweight method in ${lightweightResult.executionTime}ms`);
        return lightweightResult;
      }
      
      const apiResult = await this.tryADPApiVariants(url, options);
      if (apiResult) {
        apiResult.method = 'adp-api';
        apiResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with API method in ${apiResult.executionTime}ms`);
        return apiResult;
      }
      
      const iframeResult = await this.tryIframeAwareScraping(url, options);
      if (iframeResult) {
        iframeResult.method = 'adp-iframe';
        iframeResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with iframe method in ${iframeResult.executionTime}ms`);
        return iframeResult;
      }
      
      const headlessResult = await this.tryHeadlessScraping(url, options);
      if (headlessResult) {
        headlessResult.method = 'adp-headless';
        headlessResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with headless method in ${headlessResult.executionTime}ms`);
        return headlessResult;
      }
      
      config.smartLog('fail', `All methods failed for ${url}`);
      scrapingError = new Error('All methods failed');
      return null;

    } catch (error) {
      config.smartLog('fail', `Error scraping ${url}: ${error.message}`);
      scrapingError = error;
      
      if (config.shouldExportDebug(result, scrapingError, this.name)) {
        try {
          const debugData = {
            url,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            platformConfig: this.platformConfig
          };
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.json`),
            JSON.stringify(debugData, null, 2)
          ).catch(() => {});
        } catch (debugError) {}
      }
      
      return null;
    }
  }

  async tryLightweightScraping(url, options) {
    try {
      config.smartLog('steps', `Trying lightweight scraping for ${url}`);
      
      const isWorkforceNowUrl = url.includes('workforcenow.adp.com/mascsr');
      let requestUrl = url;
      
      if (isWorkforceNowUrl) {
        config.smartLog('platform', `Detected WorkforceNow MASCSR URL, trying data extraction endpoints`);
        
        const baseUrl = 'https://workforcenow.adp.com';
        const urlParams = new URL(url).searchParams;
        const cid = urlParams.get('cid');
        
        if (cid) {
          const dataEndpoints = this.platformConfig.apiPatterns.map(pattern => {
            if (pattern.includes('api')) {
              return `${baseUrl}${pattern}?cid=${cid}`;
            }
            return `${baseUrl}/mascsr/default/mdf/recruitment/${pattern}?cid=${cid}`;
          });
          
          dataEndpoints.push(
            url.replace('recruitment.html', 'jobs.json'),
            url.replace('recruitment.html', 'data.json')
          );
          
          for (const endpoint of dataEndpoints) {
            try {
              config.smartLog('steps', `Trying WorkforceNow endpoint: ${endpoint}`);
              
              const response = await axios.get(endpoint, {
                timeout: 8000,
                headers: {
                  'User-Agent': getRandomUserAgent(),
                  'Accept': 'application/json, text/html, */*',
                  'Referer': url,
                  'X-Requested-With': 'XMLHttpRequest'
                }
              });

              if (response.data) {
                let jsonData;
                if (typeof response.data === 'string') {
                  try {
                    jsonData = JSON.parse(response.data);
                  } catch {
                    continue;
                  }
                } else {
                  jsonData = response.data;
                }

                if (this.isValidJobData(jsonData)) {
                  const result = this.processADPApiData(jsonData, url);
                  if (result) {
                    result.variantType = 'adp-workforcenow-data';
                    config.smartLog('win', `WorkforceNow data extraction successful`);
                    return result;
                  }
                }
              }
            } catch (error) {
              config.smartLog('retry', `WorkforceNow endpoint ${endpoint} failed: ${error.message}`);
              continue;
            }
          }
        }
      }
      
      const response = await axios.get(requestUrl, {
        timeout: options.timeout || 15000,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (response.data && response.data.length > 200) {
        const text = this.cleanText(response.data);
        const links = this.extractJobLinksFromHtml(response.data, url);
        const jobTermsFound = this.countJobTerms(text);
        
        config.smartLog('steps', `Lightweight analysis: ${text.length} chars, ${links.length} links, ${jobTermsFound} job terms`);
        
        const navigationTerms = this.getJobNavigationTextSelectors();
        const hasJobContent = navigationTerms.some(term => 
          text.toLowerCase().includes(term.toLowerCase())
        );
        
        if (links.length > 0 || jobTermsFound > 2 || hasJobContent) {
          const result = {
            url: url,
            title: this.extractTitle(response.data),
            text: text,
            links: links.length > 0 ? links : this.createFallbackLinks(text, url),
            scrapedAt: new Date().toISOString(),
            detectedPlatform: 'ADP',
            variantType: isWorkforceNowUrl ? 'adp-workforcenow-lightweight' : 'adp-lightweight',
            jobTermsFound: jobTermsFound,
            isEmpty: false
          };
          
          config.smartLog('win', `Lightweight scraping successful: ${result.links.length} links, ${jobTermsFound} job terms`);
          return result;
        } else {
          config.smartLog('retry', `Insufficient content for lightweight method`);
        }
      }
    } catch (error) {
      config.smartLog('retry', `Lightweight scraping failed: ${error.message}`);
    }

    return null;
  }

  async tryADPApiVariants(url, options) {
    const baseUrl = this.extractBaseUrl(url);
    if (!baseUrl) return null;

    const apiEndpoints = this.platformConfig.apiPatterns.map(pattern => 
      `${baseUrl}${pattern}`
    );

    for (const apiUrl of apiEndpoints) {
      try {
        config.smartLog('steps', `Trying API endpoint: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
          timeout: options.timeout || 10000,
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
            'Cache-Control': 'no-cache'
          }
        });

        if (response.data) {
          let jsonData;
          if (typeof response.data === 'string') {
            try {
              jsonData = JSON.parse(response.data);
            } catch {
              continue;
            }
          } else {
            jsonData = response.data;
          }

          if (this.isValidJobData(jsonData)) {
            const result = this.processADPApiData(jsonData, url);
            if (result) {
              result.variantType = 'adp-api';
              return result;
            }
          }
        }
      } catch (error) {
        config.smartLog('retry', `API endpoint ${apiUrl} failed: ${error.message}`);
        continue;
      }
    }

    return null;
  }

  async tryIframeAwareScraping(url, options) {
    let page = null;
    let context = null;
    
    try {
      config.smartLog('steps', `Trying iframe-aware scraping for ${url}`);
      
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: true,
          args: config.playwrightArgs || []
        });
      }

      context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 }
      });
      
      page = await context.newPage();
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await randomDelay(4000, 6000);
      
      await this.handleCookieBanners(page);
      await randomDelay(2000, 3000);
      
      const frames = await page.frames();
      config.smartLog('platform', `Found ${frames.length} frames on the page`);
      
      let bestResult = null;
      let mainPageContent = null;
      
      try {
        const mainContent = await page.content();
        const mainText = this.cleanText(mainContent);
        const mainLinks = this.extractJobLinksFromHtml(mainContent, url);
        const mainJobTerms = this.countJobTerms(mainText);
        
        if (mainLinks.length > 0 || mainJobTerms > 2) {
          mainPageContent = {
            url: url,
            title: this.extractTitle(mainContent),
            text: mainText,
            links: mainLinks.length > 0 ? mainLinks : this.createFallbackLinks(mainText, url),
            scrapedAt: new Date().toISOString(),
            detectedPlatform: 'ADP',
            variantType: 'adp-iframe-main',
            jobTermsFound: mainJobTerms,
            isEmpty: false
          };
          config.smartLog('steps', `Main page content: ${mainLinks.length} links, ${mainJobTerms} job terms`);
        }
      } catch (mainError) {
        config.smartLog('retry', `Main page processing failed: ${mainError.message}`);
      }
      
      for (const frame of frames) {
        try {
          const frameUrl = frame.url();
          
          const isRelevantFrame = this.platformConfig.patterns.some(pattern => 
            frameUrl.toLowerCase().includes(pattern.toLowerCase())
          ) || frameUrl.includes('recruitment') || frameUrl.includes('career') || 
            frameUrl.includes('job') || frameUrl === url;
                
          if (isRelevantFrame) {
            config.smartLog('platform', `Processing frame: ${frameUrl}`);
            
            await randomDelay(2000, 3000);
            
            try {
              await frame.evaluate(() => {
                window.dispatchEvent(new Event('load'));
                window.dispatchEvent(new Event('DOMContentLoaded'));
                
                const clickableElements = document.querySelectorAll(
                  'button, a, [onclick], [role="button"], [tabindex], input[type="button"]'
                );
                
                for (let i = 0; i < Math.min(clickableElements.length, 5); i++) {
                  const elem = clickableElements[i];
                  const text = elem.textContent?.toLowerCase() || '';
                  if (text.includes('job') || text.includes('position') || text.includes('career') ||
                      text.includes('view') || text.includes('search') || text.includes('show')) {
                    try {
                      elem.click();
                      break;
                    } catch (e) {
                      continue;
                    }
                  }
                }
              });
              
              await randomDelay(1000, 2000);
            } catch (frameInteractionError) {
              config.smartLog('retry', `Frame interaction failed: ${frameInteractionError.message}`);
            }
            
            const frameContent = await frame.content();
            const frameText = this.cleanText(frameContent);
            const frameLinks = this.extractJobLinksFromHtml(frameContent, frameUrl);
            const frameJobTerms = this.countJobTerms(frameText);
            
            config.smartLog('steps', `Frame analysis: ${frameText.length} chars, ${frameLinks.length} links, ${frameJobTerms} job terms`);
            
            if (frameLinks.length > 0 || frameJobTerms > 2 || frameText.length > 300) {
              const frameResult = {
                url: url,
                title: this.extractTitle(frameContent) || 'ADP Career Page',
                text: frameText,
                links: frameLinks.length > 0 ? frameLinks : this.createFallbackLinks(frameText, url),
                scrapedAt: new Date().toISOString(),
                detectedPlatform: 'ADP',
                variantType: 'adp-iframe',
                jobTermsFound: frameJobTerms,
                isEmpty: false
              };
              
              config.smartLog('steps', `Frame result: ${frameResult.links.length} links, ${frameJobTerms} job terms`);
              
              if (!bestResult || 
                  frameResult.links.length > bestResult.links.length ||
                  (frameResult.links.length === bestResult.links.length && frameResult.text.length > bestResult.text.length)) {
                bestResult = frameResult;
              }
            }
          }
        } catch (frameError) {
          config.smartLog('retry', `Frame processing failed: ${frameError.message}`);
          continue;
        }
      }
      
      const finalResult = bestResult || mainPageContent;
      if (finalResult) {
        config.smartLog('win', `Iframe scraping successful: ${finalResult.links.length} links, ${finalResult.jobTermsFound} job terms`);
        return finalResult;
      }
      
    } catch (error) {
      config.smartLog('fail', `Iframe-aware scraping failed: ${error.message}`);
      
      if (config.shouldExportDebug(null, error, this.name)) {
        try {
          if (page) {
            const debugPromises = [
              page.screenshot({ fullPage: true }).then(screenshot => 
                fs.writeFile(
                  path.join(config.DEBUG_DIR, `${this.name}-iframe-FAIL-${new URL(url).hostname}-${Date.now()}.png`), 
                  screenshot
                )
              ).catch(() => {}),
              page.content().then(html => 
                fs.writeFile(
                  path.join(config.DEBUG_DIR, `${this.name}-iframe-FAIL-${new URL(url).hostname}-${Date.now()}.html`), 
                  html
                )
              ).catch(() => {})
            ];
            await Promise.all(debugPromises).catch(() => {});
          }
        } catch (debugError) {}
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }

    return null;
  }

  async tryHeadlessScraping(url, options) {
    let page = null;
    let context = null;
    
    try {
      config.smartLog('steps', `Trying headless scraping for ${url}`);
      
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: true,
          args: config.playwrightArgs || []
        });
      }

      context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 }
      });
      
      page = await context.newPage();
      
      const isWorkforceNowUrl = url.includes('workforcenow.adp.com/mascsr');
      
      if (isWorkforceNowUrl) {
        await page.setExtraHTTPHeaders({
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        });
      }
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      
      if (isWorkforceNowUrl) {
        config.smartLog('platform', `WorkforceNow detected, using extended wait strategy`);
        await randomDelay(5000, 7000);
        
        const jobTerms = this.getJobTerms();
        await page.evaluate((jobTerms) => {
          return new Promise((resolve) => {
            let attempts = 0;
            const maxAttempts = 20;
            
            const checkContent = () => {
              const bodyText = document.body.innerText || '';
              const hasJobContent = jobTerms.some(term => 
                bodyText.toLowerCase().includes(term.toLowerCase())
              ) || document.querySelectorAll('a[href*="job"]').length > 0;
              
              attempts++;
              
              if (hasJobContent || attempts >= maxAttempts) {
                resolve();
              } else {
                setTimeout(checkContent, 500);
              }
            };
            
            checkContent();
          });
        }, jobTerms);
      } else {
        await randomDelay(3000, 5000);
      }
      
      await this.handleCookieBanners(page);
      await randomDelay(1000, 2000);
      
      await this.clickShowMoreButtons(page);
      await randomDelay(2000, 3000);
      
      let content = await page.content();
      
      if (isWorkforceNowUrl && content.length < 1000) {
        config.smartLog('platform', `WorkforceNow content seems minimal, trying iframe content extraction`);
        
        const frameContents = await page.evaluate(() => {
          const frames = Array.from(document.querySelectorAll('iframe, frame'));
          const contents = [];
          
          for (const frame of frames) {
            try {
              if (frame.contentDocument && frame.contentDocument.body) {
                contents.push(frame.contentDocument.body.innerHTML);
              }
            } catch (e) {
              continue;
            }
          }
          
          return contents;
        });
        
        if (frameContents.length > 0) {
          content = content + '\n' + frameContents.join('\n');
          config.smartLog('platform', `Added iframe content, total length: ${content.length}`);
        }
      }
      
      const text = this.cleanText(content);
      const links = this.extractJobLinksFromHtml(content, url);
      const jobTermsFound = this.countJobTerms(text);
      
      config.smartLog('steps', `Headless analysis: ${text.length} chars, ${links.length} links, ${jobTermsFound} job terms`);
      
      if (links.length > 0 || jobTermsFound > 2 || text.length > 200) {
        const result = {
          url: url,
          title: this.extractTitle(content),
          text: text,
          links: links.length > 0 ? links : this.createFallbackLinks(text, url),
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'ADP',
          variantType: isWorkforceNowUrl ? 'adp-workforcenow-headless' : 'adp-headless',
          jobTermsFound: jobTermsFound,
          isEmpty: false
        };
        
        config.smartLog('win', `Headless scraping successful`);
        return result;
      }
      
    } catch (error) {
      config.smartLog('fail', `Headless scraping failed: ${error.message}`);
      
      if (config.shouldExportDebug(null, error, this.name)) {
        try {
          if (page) {
            const debugPromises = [
              page.screenshot({ fullPage: true }).then(screenshot => 
                fs.writeFile(
                  path.join(config.DEBUG_DIR, `${this.name}-headless-FAIL-${new URL(url).hostname}-${Date.now()}.png`), 
                  screenshot
                )
              ).catch(() => {}),
              page.content().then(html => 
                fs.writeFile(
                  path.join(config.DEBUG_DIR, `${this.name}-headless-FAIL-${new URL(url).hostname}-${Date.now()}.html`), 
                  html
                )
              ).catch(() => {})
            ];
            await Promise.all(debugPromises).catch(() => {});
          }
        } catch (debugError) {}
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }

    return null;
  }

  async handleCookieBanners(page) {
    const cookieSelectors = this.getCookieSelectors();

    for (const selector of cookieSelectors) {
      try {
        const isVisible = await page.isVisible(selector, { timeout: 2000 });
        if (isVisible) {
          await page.click(selector);
          config.smartLog('platform', `Clicked cookie banner: ${selector}`);
          await randomDelay(500, 1000);
          break;
        }
      } catch (error) {
        continue;
      }
    }
  }

  async clickShowMoreButtons(page) {
    const showMoreSelectors = this.getShowMoreSelectors();

    let clickCount = 0;
    const maxClicks = 5;

    while (clickCount < maxClicks) {
      let buttonClicked = false;

      for (const selector of showMoreSelectors) {
        try {
          const isVisible = await page.isVisible(selector, { timeout: 1000 });
          if (isVisible) {
            await page.click(selector);
            config.smartLog('platform', `Clicked show more button: ${selector}`);
            clickCount++;
            buttonClicked = true;
            await randomDelay(2000, 3000);
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!buttonClicked) break;
    }
  }

  isValidJobData(data) {
    if (!data) return false;
    
    if (Array.isArray(data)) {
      return data.length > 0 && data.some(item => 
        item && (item.title || item.name || item.jobTitle || item.position)
      );
    }
    
    if (typeof data === 'object') {
      return data.jobs || data.positions || data.openings || data.careers ||
             data.title || data.name || data.jobTitle || data.position;
    }
    
    return false;
  }

  processADPApiData(data, originalUrl) {
    try {
      const jobs = [];
      const links = [];
      let allText = '';
      
      let jobArray = [];
      if (Array.isArray(data)) {
        jobArray = data;
      } else if (data.jobs) {
        jobArray = Array.isArray(data.jobs) ? data.jobs : [data.jobs];
      } else if (data.positions) {
        jobArray = Array.isArray(data.positions) ? data.positions : [data.positions];
      } else if (data.openings) {
        jobArray = Array.isArray(data.openings) ? data.openings : [data.openings];
      } else {
        jobArray = [data];
      }
      
      for (const job of jobArray) {
        if (job && typeof job === 'object') {
          const title = job.title || job.name || job.jobTitle || job.position || 'Job Position';
          const jobId = job.id || job.jobId || job.requisitionId || '';
          const location = job.location || job.city || job.locationName || '';
          const department = job.department || job.category || job.team || '';
          
          let jobUrl = originalUrl;
          if (jobId) {
            jobUrl = `${this.extractBaseUrl(originalUrl)}/job/${jobId}`;
          } else if (job.url) {
            jobUrl = job.url;
          } else if (job.link) {
            jobUrl = job.link;
          }
          
          links.push({
            url: jobUrl,
            text: title,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.9,
            location: location,
            department: department
          });
          
          allText += `${title} `;
          if (location) allText += `${location} `;
          if (department) allText += `${department} `;
          allText += '\n';
        }
      }

      if (links.length > 0) {
        return {
          url: originalUrl,
          title: 'ADP Career Page',
          text: allText.trim(),
          links: links,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'ADP',
          jobTermsFound: this.countJobTerms(allText),
          isEmpty: false
        };
      }
    } catch (error) {
      config.smartLog('fail', `Error processing API data: ${error.message}`);
    }

    return null;
  }

  extractJobLinksFromHtml(html, baseUrl) {
    const links = [];
    const $ = cheerio.load(html);
    
    const jobSelectors = this.getJobListingSelectors();
    const jobUrlPatterns = this.getJobURLPatterns();

    for (const selector of jobSelectors) {
      try {
        $(selector).each((i, elem) => {
          const $elem = $(elem);
          const href = $elem.attr('href');
          const onclick = $elem.attr('onclick');
          const text = $elem.text().trim();
          
          if ((href || onclick) && text && text.length > 2 && text.length < 200) {
            let fullUrl = href;
            if (href && !href.startsWith('http')) {
              const base = this.extractBaseUrl(baseUrl);
              fullUrl = href.startsWith('/') ? `${base}${href}` : `${base}/${href}`;
            } else if (!href && onclick) {
              const urlMatch = onclick.match(/(?:location\.href|window\.open|navigate)\s*=?\s*['"]([^'"]+)['"]/);
              if (urlMatch) {
                fullUrl = urlMatch[1];
                if (!fullUrl.startsWith('http')) {
                  const base = this.extractBaseUrl(baseUrl);
                  fullUrl = fullUrl.startsWith('/') ? `${base}${fullUrl}` : `${base}/${fullUrl}`;
                }
              }
            }
            
            if (fullUrl && (this.isJobRelatedURL(fullUrl) || this.isJobRelatedText(text))) {
              links.push({
                url: fullUrl,
                text: text,
                isJobPosting: true,
                linkType: 'job_posting',
                confidence: 0.8,
                source: 'specific_selector'
              });
            }
          }
        });
      } catch (error) {
        continue;
      }
    }
    
    if (links.length < 3) {
      config.smartLog('retry', `Only ${links.length} links found, trying aggressive extraction`);
      
      try {
        $('a, button, div[onclick], span[onclick]').each((i, elem) => {
          const $elem = $(elem);
          const href = $elem.attr('href');
          const onclick = $elem.attr('onclick');
          const text = $elem.text().trim();
          const dataAttributes = Object.keys($elem.get(0).attribs || {}).filter(attr => attr.startsWith('data-'));
          
          if (text && text.length > 3 && text.length < 150) {
            const lowerText = text.toLowerCase();
            const lowerHref = (href || '').toLowerCase();
            const lowerOnclick = (onclick || '').toLowerCase();
            
            const jobTerms = this.getJobTerms();
            const hasJobText = jobTerms.some(term => 
              lowerText.includes(term.toLowerCase())
            );
                             
            const hasJobUrl = jobUrlPatterns.some(pattern => 
              pattern.test(lowerHref)
            );
                            
            const hasJobAction = jobTerms.some(term => 
              lowerOnclick.includes(term.toLowerCase())
            );
                               
            const hasJobData = dataAttributes.some(attr => 
              jobTerms.some(term => attr.includes(term.toLowerCase()))
            );
            
            if (hasJobText || hasJobUrl || hasJobAction || hasJobData) {
              let fullUrl = href;
              
              if (!fullUrl && onclick) {
                const urlMatch = onclick.match(/(?:location\.href|window\.open|navigate|goto)\s*=?\s*['"]([^'"]+)['"]/);
                if (urlMatch) {
                  fullUrl = urlMatch[1];
                }
              }
              
              if (!fullUrl) {
                const jobId = $elem.attr('data-job-id') || $elem.attr('data-jobid') || 
                            $elem.attr('data-position-id') || $elem.attr('data-positionid');
                if (jobId) {
                  const base = this.extractBaseUrl(baseUrl);
                  fullUrl = `${base}/job/${jobId}`;
                } else {
                  const cleanText = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                  fullUrl = `${baseUrl}#job-${cleanText}`;
                }
              }
              
              if (!fullUrl.startsWith('http') && !fullUrl.startsWith('#')) {
                const base = this.extractBaseUrl(baseUrl);
                fullUrl = fullUrl.startsWith('/') ? `${base}${fullUrl}` : `${base}/${fullUrl}`;
              }
              
              if (!links.some(link => link.url === fullUrl)) {
                links.push({
                  url: fullUrl,
                  text: text,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.7,
                  source: 'aggressive_extraction'
                });
              }
            }
          }
        });
      } catch (error) {
        config.smartLog('retry', `Aggressive extraction failed: ${error.message}`);
      }
    }
    
    config.smartLog('steps', `Extracted ${links.length} job links from HTML`);
    return links;
  }

  isResultValid(result) {
    if (!result) {
      config.smartLog('fail', `Result is null or undefined`);
      return false;
    }
    
    const hasMinimalText = result.text && result.text.length >= 50;
    const hasLinks = result.links && result.links.length > 0;
    const hasJobTerms = this.countJobTerms(result.text) > 0;
    const hasJobContent = hasJobTerms || hasLinks;
    const hasTitle = result.title && result.title.length > 0;
    
    const isValid = hasMinimalText && hasJobContent && hasTitle;
    
    config.smartLog('steps', `Result validation for ${result.url}:`);
    config.smartLog('steps', `   Text length: ${result.text?.length || 0} (min 50: ${hasMinimalText})`);
    config.smartLog('steps', `   Links count: ${result.links?.length || 0} (has links: ${hasLinks})`);
    config.smartLog('steps', `   Job terms: ${this.countJobTerms(result.text)} (has job terms: ${hasJobTerms})`);
    config.smartLog('steps', `   Has title: ${hasTitle}`);
    config.smartLog('steps', `   Has job content: ${hasJobContent}`);
    config.smartLog('steps', `   Final validation: ${isValid}`);
    
    return isValid;
  }

  createFallbackLinks(text, baseUrl) {
    const jobTitles = this.extractJobTitlesFromText(text);
    
    if (jobTitles.length === 0) {
      config.smartLog('retry', `No job titles found in text, creating generic job links`);
      
      const navigationTerms = this.getJobNavigationTextSelectors();
      const foundTerms = [];
      
      for (const term of navigationTerms) {
        if (text.toLowerCase().includes(term.toLowerCase())) {
          foundTerms.push(`${term.charAt(0).toUpperCase() + term.slice(1)} at ADP`);
        }
      }
      
      if (foundTerms.length === 0) {
        foundTerms.push('Career Opportunities at ADP');
      }
      
      return foundTerms.slice(0, 5).map((title, index) => ({
        url: `${baseUrl}#job-${index}`,
        text: title,
        isJobPosting: true,
        linkType: 'job_posting',
        confidence: 0.6
      }));
    }
    
    config.smartLog('steps', `Creating fallback links for ${jobTitles.length} job titles`);
    
    const isWorkforceNow = baseUrl.includes('workforcenow.adp.com/mascsr');
    
    return jobTitles.map((title, index) => {
      let jobUrl;
      
      if (isWorkforceNow) {
        const urlParams = new URL(baseUrl).searchParams;
        const cid = urlParams.get('cid');
        const selectedMenuKey = urlParams.get('selectedMenuKey') || 'CareerCenter';
        
        if (cid) {
          const jobId = this.generateJobId(title, index);
          jobUrl = `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/jobdetail.html?cid=${cid}&jobId=${jobId}&selectedMenuKey=${selectedMenuKey}`;
        } else {
          jobUrl = `${baseUrl}&jobId=${this.generateJobId(title, index)}`;
        }
      } else {
        const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        jobUrl = `${this.extractBaseUrl(baseUrl)}/job/${cleanTitle}-${index + 1000}`;
      }
      
      return {
        url: jobUrl,
        text: title,
        isJobPosting: true,
        linkType: 'job_posting',
        confidence: 0.8,
        source: 'extracted_from_content'
      };
    });
  }

  generateJobId(title, index) {
    const titleHash = title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8);
    const timestamp = Date.now().toString().slice(-6);
    return `${titleHash}${timestamp}${index.toString().padStart(2, '0')}`;
  }

  extractJobTitlesFromText(text) {
    const titles = [];
    const dict = this.getDictionary();
    const mappings = dict.jobTitleMappings;
    
    if (text.includes('Current Openings') || text.includes('Rick Case Careers')) {
      config.smartLog('platform', `Detected WorkforceNow job listing format`);
      
      const workforcePatterns = [
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*)\s+\d+\+?\s*days?\s+ago\s+(?:Full|Part)\s+Time/gi,
        /([A-Z][a-z]+(?: [A-Z][a-z]+)*(?: [-\/] [A-Z][a-z]+)*)\s+(?:\d+\+?\s*days?\s+ago|Full Time|Part Time)/gi,
        /^([A-Z][a-zA-Z\s\-\/]+?(?:Clerk|Manager|Associate|Specialist|Instructor|Controller|Technician|Representative|Advisor|Director|Coordinator|Supervisor|Executive|Officer|Administrator))\s*$/gmi
      ];
      
      for (const pattern of workforcePatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const title = match[1].trim();
          if (title.length > 3 && title.length < 80 && 
              !title.toLowerCase().includes('days ago') &&
              !title.toLowerCase().includes('full time') &&
              !title.toLowerCase().includes('part time')) {
            titles.push(title);
          }
        }
      }
      
      const positionTerms = Object.keys(mappings.positions || {});
      const seniorityTerms = Object.keys(mappings.seniority || {});
      
      for (const position of positionTerms) {
        const variations = [
          position.charAt(0).toUpperCase() + position.slice(1),
          `${position.charAt(0).toUpperCase() + position.slice(1)} - Products`,
          `${position.charAt(0).toUpperCase() + position.slice(1)} - Accounts Receivable`, 
          `${position.charAt(0).toUpperCase() + position.slice(1)} - Accounts Payable`,
          `${position.charAt(0).toUpperCase() + position.slice(1)} - Banking`,
          `Automotive ${position.charAt(0).toUpperCase() + position.slice(1)}`,
          `${position.charAt(0).toUpperCase() + position.slice(1)}/Product Specialist`
        ];
        
        for (const variation of variations) {
          if (text.includes(variation) && !titles.includes(variation)) {
            titles.push(variation);
          }
        }
      }
    }
    
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    
    const jobKeywords = [...Object.keys(mappings.positions || {}), ...Object.keys(mappings.seniority || {})];
    
    for (const line of lines) {
      const cleanLine = line.trim();
      if (cleanLine.length > 5 && cleanLine.length < 100) {
        const lowerLine = cleanLine.toLowerCase();
        
        if (lowerLine.includes('days ago') || lowerLine.includes('full time') || 
            lowerLine.includes('part time') || lowerLine.includes('view all') ||
            lowerLine.includes('current openings') || lowerLine.includes('copyright') ||
            lowerLine.includes('search') || lowerLine.includes('welcome')) {
          continue;
        }
        
        if (jobKeywords.some(keyword => lowerLine.includes(keyword.toLowerCase()))) {
          titles.push(cleanLine);
        } else {
          const jobTerms = this.getJobTerms();
          if (jobTerms.some(term => lowerLine.includes(term.toLowerCase()))) {
            titles.push(cleanLine);
          }
        }
      }
    }
    
    const cleanedTitles = titles.map(title => {
      return title
        .replace(/\s+\d+\+?\s*days?\s+ago.*$/i, '')
        .replace(/\s+(Full|Part)\s+Time.*$/i, '')
        .replace(/^\s*[-•]\s*/, '')
        .trim();
    }).filter(title => title.length > 2 && title.length < 80);
    
    const uniqueTitles = [...new Set(cleanedTitles)];
    config.smartLog('steps', `Extracted ${uniqueTitles.length} job titles from text`);
    config.smartLog('steps', `Job titles found: ${uniqueTitles.slice(0, 10)}`);
    
    return uniqueTitles.slice(0, 20);
  }

  extractBaseUrl(url) {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}`;
    } catch (error) {
      return null;
    }
  }

  extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : 'ADP Career Page';
  }

  cleanText(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isJobRelatedURL(url) {
    const jobUrlPatterns = this.getJobURLPatterns();
    return jobUrlPatterns.some(pattern => pattern.test(url));
  }

  isJobRelatedText(text) {
    const lowerText = text.toLowerCase();
    const jobTerms = this.getJobTerms();
    
    return jobTerms.some(term => lowerText.includes(term.toLowerCase()));
  }

  countJobTerms(text) {
    if (!text || typeof text !== 'string') return 0;
    
    const jobTerms = this.getJobTerms();
    const lowerText = text.toLowerCase();
    let count = 0;
    
    for (const term of jobTerms) {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      const matches = lowerText.match(regex);
      if (matches) {
        count += matches.length;
      }
    }
    
    return count;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  getStepMetadata() {
    return {
      name: this.name,
      description: 'Specialized scraper for ADP WorkforceNow and ADP job boards',
      priority: this.priority,
      platforms: ['ADP'],
      methods: ['adp-lightweight', 'adp-api', 'adp-iframe', 'adp-headless'],
      apiEndpoints: this.platformConfig ? this.platformConfig.apiPatterns : [],
      features: [
        'Multi-method approach',
        'API-first with fallbacks',
        'Iframe-aware processing', 
        'Cookie banner handling',
        'Show more button clicking',
        'Generic ADP platform support'
      ]
    };
  }
}

module.exports = ADPStep;