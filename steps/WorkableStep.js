const { chromium } = require('playwright');
const cheerio = require('cheerio');
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const config = require('../../config');
const path = require('path');
const fs = require('fs').promises;

class WorkableStep extends BaseScraperStep {
  constructor() {
    super('workable-step', 2);
    this.browser = null;
  }

  async isApplicable(url, context = {}) {
    const platform = this.detectJobPlatform(url, context.html || '');
    
    if (platform && platform.name === 'Workable') {
      config.smartLog('platform', `Platform detected as Workable for ${url}`);
      return true;
    }
    
    const urlLower = url.toLowerCase();
    const isWorkableUrl = urlLower.includes('workable.com') || urlLower.includes('apply.workable.com');
    
    if (isWorkableUrl) {
      config.smartLog('platform', `Workable URL pattern detected for ${url}`);
      return true;
    }
    
    return false;
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--no-sandbox',
          '--disable-setuid-sandbox'
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

  async scrape(url, options = {}) {
    config.smartLog('steps', `Universal scraping for: ${url}`);
    
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
        javaScriptEnabled: true
      });

      await context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'media', 'font', 'manifest'].includes(resourceType)) {
          return route.abort();
        }
        route.continue();
      });

      page = await context.newPage();
      page.setDefaultTimeout(20000);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await randomDelay(1000, 2000);

      await this.handleCookiesUniversal(page);
      await this.loadAllJobsUniversal(page);

      const content = await this.extractContentUniversal(page, url);
      
      if (this.isResultValid(content)) {
        config.smartLog('win', `Successfully extracted ${content.links.length} links`);
        config.smartLog('win', `Job titles found: ${content.links.filter(l => l.isJobPosting).map(l => l.text).join(', ')}`);
        result = content;
      } else {
        config.smartLog('fail', `Invalid result for ${url}`);
        scrapingError = new Error('Invalid result');
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
    }
  }

  async handleCookiesUniversal(page) {
    try {
      const cookieSelectors = this.getCookieSelectors();
      const cookieTexts = this.getCookieTextSelectors();

      for (const selector of cookieSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            await button.click();
            await randomDelay(500, 1000);
            config.smartLog('platform', `Cookie banner handled with selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
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
                console.log('Cookie button clicked:', text);
                return;
              } catch (e) {
                console.log('Failed to click cookie button:', e.message);
              }
            }
          }
        }
      }, cookieTexts);
    } catch (error) {
      config.smartLog('retry', `Cookie handling failed: ${error.message}`);
    }
  }

  async loadAllJobsUniversal(page) {
    const maxAttempts = 20;
    let attempts = 0;
    let previousJobCount = 0;

    while (attempts < maxAttempts) {
      const jobListingSelectors = this.getJobListingSelectors();
      
      const currentJobCount = await page.evaluate((jobSelectors) => {
        let maxCount = 0;
        for (const selector of jobSelectors) {
          try {
            const count = document.querySelectorAll(selector).length;
            if (count > maxCount) maxCount = count;
          } catch (e) {
            continue;
          }
        }
        return maxCount;
      }, jobListingSelectors);

      if (currentJobCount === previousJobCount && attempts > 2) {
        config.smartLog('steps', `No new jobs loaded, stopping. Final count: ${currentJobCount}`);
        break;
      }

      const showMoreSelectors = this.getShowMoreSelectors();
      const showMoreTexts = this.getShowMoreTextSelectors();

      const loadMoreClicked = await page.evaluate((data) => {
        const { selectors, textSelectors } = data;
        
        for (const selector of selectors) {
          try {
            const button = document.querySelector(selector);
            if (button && button.offsetWidth > 0 && button.offsetHeight > 0 && !button.disabled) {
              button.scrollIntoView({ behavior: 'smooth', block: 'center' });
              button.click();
              return true;
            }
          } catch (e) {
            continue;
          }
        }

        const buttons = document.querySelectorAll('button, [role="button"], a, input[type="button"]');
        for (const button of buttons) {
          const text = (button.textContent || '').trim();
          const textLower = text.toLowerCase();
          
          if (text.length > 0 && text.length < 50) {
            const isShowMore = textSelectors.some(pattern => {
              if (typeof pattern === 'string') {
                return textLower.includes(pattern.toLowerCase());
              } else if (pattern instanceof RegExp) {
                return pattern.test(text);
              }
              return false;
            });
            
            if (isShowMore && button.offsetWidth > 0 && button.offsetHeight > 0 && !button.disabled) {
              button.scrollIntoView({ behavior: 'smooth', block: 'center' });
              button.click();
              return true;
            }
          }
        }

        return false;
      }, { selectors: showMoreSelectors, textSelectors: showMoreTexts });

      if (loadMoreClicked) {
        config.smartLog('steps', `Load more clicked, waiting for new content...`);
        await this.waitForContentUniversal(page);
      } else {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await randomDelay(1000, 1500);
      }

      previousJobCount = currentJobCount;
      attempts++;
    }

    config.smartLog('steps', `Finished loading jobs after ${attempts} attempts`);
  }

  async waitForContentUniversal(page) {
    try {
      await page.waitForTimeout(1500);
      
      const loadingSelectors = this.getLoadingIndicators();
      
      await page.evaluate((loadingSelectors) => {
        return new Promise(resolve => {
          let checks = 0;
          const maxChecks = 10;
          
          const checkForLoading = () => {
            checks++;
            
            let isLoading = false;
            for (const selector of loadingSelectors) {
              try {
                const elements = document.querySelectorAll(selector);
                isLoading = Array.from(elements).some(el => 
                  el.offsetWidth > 0 && el.offsetHeight > 0
                );
                if (isLoading) break;
              } catch (e) {
                continue;
              }
            }
            
            if (!isLoading || checks >= maxChecks) {
              resolve();
            } else {
              setTimeout(checkForLoading, 300);
            }
          };
          
          checkForLoading();
        });
      }, loadingSelectors);
    } catch (error) {
      config.smartLog('retry', `Wait for content failed: ${error.message}`);
    }
  }

  async extractContentUniversal(page, url) {
    config.smartLog('steps', `Starting universal content extraction`);
    
    const jobListingSelectors = this.getJobListingSelectors();
    const jobTerms = this.getJobTerms();
    const dict = this.getDictionary();
    const locationTerms = dict.locationTerms || ['remote', 'on-site', 'hybrid', 'office', 'location', 'city', 'country'];
    const timeTerms = dict.timeTerms || ['full time', 'part time', 'contract', 'internship', 'temporary', 'permanent'];
    const postedTerms = dict.postedTerms || ['posted', 'ago', 'days', 'weeks', 'months'];
    
    const extractedData = await page.evaluate((data) => {
      const { url, jobSelectors, jobTerms, locationTerms, timeTerms, postedTerms } = data;
      
      const result = {
        url: url,
        title: document.title || '',
        text: '',
        links: [],
        scrapedAt: new Date().toISOString(),
        method: 'workable-step',
        detectedPlatform: 'Universal',
        hasJobListings: 0,
        debug: {
          extractionMethod: 'universal',
          foundJobTitles: [],
          foundJobUrls: []
        }
      };

      const fullText = document.body.innerText || document.body.textContent || '';
      result.text = fullText;

      const extractWorkableJobsAdvanced = () => {
        const jobs = [];
        
        const workableSelectors = [
          '[data-ui="job"]',
          '.job-item',
          '.position-item',
          '[class*="job"]',
          '[class*="position"]',
          'tbody tr',
          'tr[role="row"]',
          'div[role="row"]'
        ];
        
        let foundJobElements = [];
        
        for (const selector of workableSelectors) {
          try {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              foundJobElements = Array.from(elements);
              console.log(`Found ${foundJobElements.length} job elements with selector: ${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
        
        for (const element of foundJobElements) {
          try {
            const titleSelectors = [
              'h3', 'h4', 'h5', '.title', '[class*="title"]', 
              '[class*="name"]', 'td:first-child', 'div:first-child',
              'a', '[role="link"]'
            ];
            
            let titleElement = null;
            let titleText = '';
            
            for (const titleSelector of titleSelectors) {
              const el = element.querySelector(titleSelector);
              if (el && el.textContent && el.textContent.trim().length > 3) {
                titleElement = el;
                titleText = el.textContent.trim();
                break;
              }
            }
            
            if (!titleText) {
              const directText = element.textContent.trim();
              const lines = directText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
              if (lines.length > 0) {
                titleText = lines[0];
              }
            }
            
            if (!titleText || titleText.length < 3) continue;
            
            const hasJobTerms = jobTerms.some(term => 
              titleText.toLowerCase().includes(term.toLowerCase())
            );
            
            if (!hasJobTerms && titleText.length < 50) {
              const commonJobWords = ['engineer', 'developer', 'manager', 'specialist', 'analyst', 
                                    'designer', 'coordinator', 'lead', 'senior', 'junior', 'intern'];
              const hasCommonJobWords = commonJobWords.some(word => 
                titleText.toLowerCase().includes(word)
              );
              
              if (!hasCommonJobWords) continue;
            }
            
            let jobUrl = url;
            const linkElement = element.querySelector('a[href]') || titleElement;
            if (linkElement && linkElement.href) {
              try {
                jobUrl = new URL(linkElement.href, url).href;
              } catch (e) {
                jobUrl = url + '#job-' + jobs.length;
              }
            } else {
              jobUrl = url + '#job-' + jobs.length;
            }
            
            const elementText = element.textContent || '';
            const hasLocationInfo = locationTerms.some(term => 
              elementText.toLowerCase().includes(term.toLowerCase())
            );
            const hasTimeInfo = timeTerms.some(term => 
              elementText.toLowerCase().includes(term.toLowerCase())
            );
            const hasPostedInfo = postedTerms.some(term => 
              elementText.toLowerCase().includes(term.toLowerCase())
            );
            
            const confidence = hasPostedInfo ? 0.95 : (hasLocationInfo || hasTimeInfo) ? 0.85 : 0.75;
            
            jobs.push({
              title: titleText,
              url: jobUrl,
              confidence: confidence,
              context: elementText.substring(0, 200),
              hasLocationInfo,
              hasTimeInfo,
              hasPostedInfo
            });
            
            console.log(`Found Workable job: ${titleText} (confidence: ${confidence})`);
            
          } catch (e) {
            console.log('Error processing job element:', e.message);
            continue;
          }
        }
        
        if (jobs.length === 0) {
          console.log('No structured jobs found, trying text-based extraction');
          
          const lines = fullText.split('\n').map(line => line.trim()).filter(line => line.length > 3);
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.length > 100) continue;
            
            const hasJobTerms = jobTerms.some(term => 
              line.toLowerCase().includes(term.toLowerCase())
            );
            
            const commonJobWords = ['engineer', 'developer', 'manager', 'specialist', 'analyst', 
                                  'designer', 'coordinator', 'lead', 'senior', 'junior', 'architect'];
            const hasCommonJobWords = commonJobWords.some(word => 
              line.toLowerCase().includes(word)
            );
            
            if (!hasJobTerms && !hasCommonJobWords) continue;
            
            const nextLines = lines.slice(i + 1, i + 4);
            const contextText = nextLines.join(' ');
            
            const hasLocationInfo = locationTerms.some(term => 
              contextText.toLowerCase().includes(term.toLowerCase())
            );
            const hasTimeInfo = timeTerms.some(term => 
              contextText.toLowerCase().includes(term.toLowerCase())
            );
            const hasPostedInfo = postedTerms.some(term => 
              contextText.toLowerCase().includes(term.toLowerCase())
            );
            
            if (hasLocationInfo || hasTimeInfo || hasPostedInfo) {
              const confidence = hasPostedInfo ? 0.8 : 0.7;
              
              jobs.push({
                title: line,
                url: url + '#text-job-' + jobs.length,
                confidence: confidence,
                context: contextText,
                hasLocationInfo,
                hasTimeInfo,
                hasPostedInfo
              });
              
              console.log(`Found text-based job: ${line} (confidence: ${confidence})`);
            }
          }
        }
        
        return jobs;
      };

      const jobs = extractWorkableJobsAdvanced();
      
      console.log(`[WorkableStep] Total jobs found: ${jobs.length}`);
      
      result.debug.foundJobTitles = jobs.map(j => j.title);
      result.debug.foundJobUrls = jobs.map(j => j.url);
      result.hasJobListings = jobs.length;

      for (const job of jobs) {
        result.links.push({
          url: job.url,
          text: job.title,
          isJobPosting: true,
          linkType: 'job_posting',
          confidence: job.confidence,
          platform: 'Workable',
          extractionMethod: 'workable_advanced',
          debug: {
            hasLocationInfo: job.hasLocationInfo,
            hasTimeInfo: job.hasTimeInfo,
            hasPostedInfo: job.hasPostedInfo,
            context: job.context
          }
        });
      }

      const otherLinks = document.querySelectorAll('a[href]');
      for (const link of otherLinks) {
        const href = link.href;
        const text = link.textContent?.trim() || '';
        
        if (!href.includes('/job/') && !href.includes('/j/') && !href.includes('/position/')) {
          const isJobRelated = jobTerms.some(term => 
            href.toLowerCase().includes(term) || text.toLowerCase().includes(term)
          );
          
          if (isJobRelated && text.length > 3) {
            const alreadyExists = result.links.some(existingLink => 
              existingLink.url === href || existingLink.text === text
            );
            
            if (!alreadyExists) {
              result.links.push({
                url: href,
                text: text,
                isJobPosting: false,
                linkType: 'job_related',
                confidence: 0.6,
                platform: 'Workable',
                extractionMethod: 'additional_links'
              });
            }
          }
        }
      }

      console.log(`[WorkableStep] Final extraction: ${result.links.length} total links, ${result.links.filter(l => l.isJobPosting).length} job postings`);
      
      return result;
    }, { 
      url, 
      jobSelectors: jobListingSelectors, 
      jobTerms, 
      locationTerms, 
      timeTerms, 
      postedTerms 
    });

    config.smartLog('steps', `Extraction complete - ${extractedData.links.length} links found`);
    config.smartLog('steps', `Job titles extracted: ${extractedData.debug?.foundJobTitles?.join(', ') || 'none'}`);
    
    return extractedData;
  }

  isResultValid(result) {
    if (!super.isResultValid(result)) return false;

    const hasJobLinks = result.links.some(link => 
      link.isJobPosting || 
      link.linkType === 'job_posting' ||
      link.linkType === 'job_related'
    );

    const hasJobContent = this.countJobTerms(result.text) > 0 ||
                         result.hasJobListings > 0;

    const hasRealJobTitles = result.links.some(link => 
      link.isJobPosting && 
      link.text && 
      link.text !== 'Link' && 
      link.text !== 'Job Opening' &&
      link.text.length > 5
    );

    config.smartLog('steps', `Validation - Job Links: ${hasJobLinks}, Job Content: ${hasJobContent}, Real Titles: ${hasRealJobTitles}`);

    return hasJobLinks || hasJobContent;
  }
}

module.exports = WorkableStep;