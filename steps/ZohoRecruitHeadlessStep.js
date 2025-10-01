const BaseScraperStep = require('./BaseScraperStep');
const { chromium } = require('playwright');
const config = require('../../config');
const fs = require('fs').promises;
const path = require('path');

class ZohoRecruitHeadlessStep extends BaseScraperStep {
  constructor() {
    super('zoho-recruit-headless-step', 8);
    this.maxExecutionTime = 30000;
    this.popupWaitTime = 2000;
    this.jobLoadWaitTime = 5000;
  }

  async isApplicable(url, context = {}) {
    const urlLower = url.toLowerCase();
    
    if (context.detectedPlatform === 'ZohoRecruit') {
      config.smartLog('platform', `ZohoRecruit platform detected`);
      return true;
    }
    
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const zohoConfig = platforms.find(p => p.name === 'ZohoRecruit');
    
    if (zohoConfig && zohoConfig.patterns) {
      const isZohoDomain = zohoConfig.patterns.some(pattern => urlLower.includes(pattern));
      if (isZohoDomain) {
        config.smartLog('platform', `ZohoRecruit domain detected`);
        return true;
      }
    }
    
    if (context.previousStepResult?.requiresHeadless || context.previousStepResult?.variantType?.includes('dynamic')) {
      config.smartLog('steps', `Previous step indicates headless required`);
      return true;
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting headless scraping for ${url}`);
    
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
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-blink-features=AutomationControlled'
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
      
      page.on('console', msg => {
        if (msg.type() === 'log') {
          config.smartLog('steps', `Browser Console: ${msg.text()}`);
        }
      });
      
      config.smartLog('steps', `Navigating to ${url}`);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      
      await page.waitForTimeout(3000);
      
      config.smartLog('steps', `Handling cookies and popups`);
      await this.handleCookiesAndPopups(page);
      
      config.smartLog('steps', `Waiting for jobs to load`);
      await this.waitForJobs(page);
      
      config.smartLog('steps', `Extracting jobs`);
      const jobs = await this.extractJobs(page, url);
      
      config.smartLog('steps', `Found ${jobs.length} jobs`);
      
      if (jobs.length === 0) {
        config.smartLog('steps', `No jobs found, trying aggressive extraction`);
        const aggressiveJobs = await this.aggressiveJobExtraction(page);
        jobs.push(...aggressiveJobs);
      }
      
      const title = await page.title();
      
      await browser.close();
      
      if (jobs.length > 0) {
        result = {
          url: url,
          title: title,
          text: this.extractTextFromJobs(jobs),
          links: jobs,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'ZohoRecruit',
          variantType: 'zoho-recruit-headless',
          jobTermsFound: this.countJobTerms(this.extractTextFromJobs(jobs)),
          isEmpty: false,
          method: 'zoho-recruit-headless',
          executionTime: Date.now() - startTime
        };
        config.smartLog('win', `Successfully found ${jobs.length} jobs`);
      } else {
        config.smartLog('fail', `No jobs found after all attempts`);
        scrapingError = new Error('No jobs found after all attempts');
        
        result = {
          url: url,
          title: title,
          text: 'Page loaded but no jobs found. Jobs may require additional interaction or authentication.',
          links: [],
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'ZohoRecruit',
          variantType: 'zoho-recruit-headless-empty',
          jobTermsFound: 0,
          isEmpty: true,
          method: 'zoho-recruit-headless',
          executionTime: Date.now() - startTime,
          requiresManualCheck: true
        };
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
      config.smartLog('fail', `Error: ${error.message}`);
      if (browser) await browser.close();
      scrapingError = error;
    }
    
    return result;
  }

  async handleCookiesAndPopups(page) {
    try {
      await page.waitForTimeout(1000);
      await page.mouse.click(10, 10);
      await page.waitForTimeout(500);
      
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
                return;
              } catch (e) {}
            }
          }
        }
      }, cookieTextSelectors);
      
      const dict = this.getDictionary();
      const universalSelectors = dict.getUniversalSelectors();
      const genericPopupSelectors = universalSelectors.popupCloseSelectors || [
        'button:has-text("Close")', 'button:has-text("×")', 'button:has-text("X")',
        '[class*="close-button"]', '[class*="modal-close"]',
        '[class*="popup"] button', '[class*="modal"] button', '[class*="dialog"] button',
        'button[class*="close"]', 'a[class*="close"]', '[role="button"][aria-label*="close"]',
        '.modal-backdrop', '[class*="overlay"]', '[class*="backdrop"]'
      ];
      
      for (const selector of genericPopupSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            for (const element of elements) {
              try {
                const isVisible = await element.isVisible();
                if (isVisible) {
                  await element.click();
                  config.smartLog('steps', `Clicked popup close button`);
                  await page.waitForTimeout(500);
                  break;
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
      
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      
      await page.mouse.click(50, 50);
      await page.waitForTimeout(500);
      
    } catch (error) {
      config.smartLog('fail', `Error handling cookies/popups: ${error.message}`);
    }
  }

  async waitForJobs(page) {
    try {
      await page.waitForTimeout(2000);
      
      const jobListingSelectors = this.getJobListingSelectors();
      
      let found = false;
      for (const selector of jobListingSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            config.smartLog('steps', `Found ${elements.length} elements with selector: ${selector}`);
            found = true;
            break;
          }
        } catch (e) {}
      }
      
      if (!found) {
        config.smartLog('steps', `No job selectors found immediately, waiting for dynamic content`);
        
        try {
          await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch (e) {
          config.smartLog('timeout', `Network idle timeout, continuing`);
        }
        
        await page.waitForTimeout(3000);
        
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(2000);
      }
      
    } catch (error) {
      config.smartLog('fail', `Error waiting for jobs: ${error.message}`);
    }
  }

  async extractJobs(page, url) {
    const jobs = [];
    
    try {
      config.smartLog('steps', `Starting job extraction`);
      
      const mainPageJobs = await this.extractJobsFromPage(page);
      jobs.push(...mainPageJobs);
      
      const frames = page.frames();
      config.smartLog('steps', `Checking ${frames.length} frames for jobs`);
      
      for (const frame of frames) {
        try {
          const frameUrl = frame.url();
          if (frameUrl && frameUrl !== 'about:blank') {
            config.smartLog('steps', `Checking frame: ${frameUrl}`);
            const frameJobs = await this.extractJobsFromPage(frame);
            jobs.push(...frameJobs);
          }
        } catch (e) {
          config.smartLog('fail', `Error extracting from frame: ${e.message}`);
        }
      }
      
      const uniqueJobs = [];
      const seenTitles = new Set();
      
      for (const job of jobs) {
        if (!seenTitles.has(job.text)) {
          seenTitles.add(job.text);
          uniqueJobs.push(job);
        }
      }
      
      config.smartLog('steps', `Total unique jobs found: ${uniqueJobs.length}`);
      
    } catch (error) {
      config.smartLog('fail', `Error extracting jobs: ${error.message}`);
    }
    
    return jobs;
  }
  
  async extractJobsFromPage(pageOrFrame) {
    const jobs = [];
    
    try {
      const jobListingSelectors = this.getJobListingSelectors();
      const jobTerms = this.getJobTerms();
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const zohoConfig = platforms.find(p => p.name === 'ZohoRecruit');
      const zohoSelectors = zohoConfig?.selectors || [];
      
      const jobData = await pageOrFrame.evaluate((data) => {
        const { jobSelectors, jobTerms, zohoSelectors } = data;
        const results = [];
        
        const selectors = [
          ...zohoSelectors,
          ...jobSelectors,
          { selector: 'a[href*="/jobs/"][href*="/view"]', titleSel: null, linkSel: null },
          { selector: 'a[href*="Opening_Id="]', titleSel: null, linkSel: null },
          { selector: 'a[href*="recruit"][href*="view"]', titleSel: null, linkSel: null },
          { selector: 'table tr:has(td:has(a))', titleSel: 'td:nth-child(2) a, td a', linkSel: 'a' },
          { selector: 'table tbody tr', titleSel: 'td:nth-child(2)', linkSel: 'td a' },
          { selector: 'a[href*="/view"]:not([href*="login"])', titleSel: null, linkSel: null }
        ];
        
        for (const selectorData of selectors) {
          const selector = typeof selectorData === 'string' ? selectorData : selectorData.selector;
          const titleSel = selectorData.titleSel;
          const linkSel = selectorData.linkSel;
          
          try {
            const elements = document.querySelectorAll(selector);
            
            elements.forEach(el => {
              let title = '';
              let jobUrl = '';
              let location = '';
              let workType = '';
              
              if (titleSel) {
                const titleEl = el.querySelector(titleSel);
                if (titleEl) {
                  title = titleEl.textContent.trim();
                }
              } else {
                title = el.textContent.trim();
              }
              
              if (linkSel) {
                const linkEl = el.querySelector(linkSel);
                if (linkEl) {
                  jobUrl = linkEl.href || linkEl.getAttribute('href') || '';
                }
              } else if (el.tagName === 'A') {
                jobUrl = el.href || el.getAttribute('href') || '';
              }
              
              if (!jobUrl && el.getAttribute('onclick')) {
                const onclick = el.getAttribute('onclick');
                const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)['"]/);
                if (urlMatch) {
                  jobUrl = urlMatch[1];
                }
              }
              
              const locationSelectors = ['.location', '[class*="location"]', 'td:nth-child(4)', 'td:nth-child(3)'];
              for (const locSel of locationSelectors) {
                const locationEl = el.querySelector(locSel);
                if (locationEl) {
                  location = locationEl.textContent.trim();
                  break;
                }
              }
              
              const typeSelectors = ['.job-type', '[class*="type"]', 'td:nth-child(5)', 'td:nth-child(4)'];
              for (const typeSel of typeSelectors) {
                const typeEl = el.querySelector(typeSel);
                if (typeEl) {
                  workType = typeEl.textContent.trim();
                  break;
                }
              }
              
              const parentText = el.closest('tr, div, li')?.textContent || el.textContent;
              
              if (!location) {
                const locationMatch = parentText.match(/([A-Za-z\s]+,\s*[A-Z]{2})/);
                if (locationMatch) location = locationMatch[1];
              }
              
              if (!workType) {
                const textLower = parentText.toLowerCase();
                if (textLower.includes('full time') || textLower.includes('full-time')) workType = 'Full time';
                else if (textLower.includes('part time') || textLower.includes('part-time')) workType = 'Part time';
                else if (textLower.includes('contract')) workType = 'Contract';
              }
              
              if (title && title.length > 3 && title.length < 150) {
                title = title.replace(/\s+/g, ' ').trim();
                
                const invalidPatterns = [
                  /^\d{2}\/\d{2}\/\d{4}$/,
                  /^(filter|sort|search|apply|close|next|back|home|about|contact)$/i,
                  /^page \d+$/i,
                  /^\d+$/
                ];
                
                let isValid = true;
                for (const pattern of invalidPatterns) {
                  if (pattern.test(title)) {
                    isValid = false;
                    break;
                  }
                }
                
                if (isValid) {
                  const isDuplicate = results.some(r => r.title === title);
                  if (!isDuplicate) {
                    results.push({
                      title,
                      url: jobUrl || '',
                      location: location || '',
                      workType: workType || ''
                    });
                  }
                }
              }
            });
          } catch (e) {}
        }
        
        const allTables = document.querySelectorAll('table');
        allTables.forEach((table) => {
          const rows = table.querySelectorAll('tr');
          
          rows.forEach((row, index) => {
            if (index === 0) return;
            
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              const firstCell = cells[0].textContent.trim();
              
              if (/^\d{2}\/\d{2}\/\d{4}$/.test(firstCell)) {
                const titleCell = cells[1];
                const title = titleCell.textContent.trim();
                const link = titleCell.querySelector('a');
                const jobUrl = link ? (link.href || link.getAttribute('href') || '') : '';
                const location = cells.length > 3 ? cells[3].textContent.trim() : '';
                const workType = cells.length > 4 ? cells[4].textContent.trim() : '';
                
                if (title && title.length > 3 && title.length < 150) {
                  const isDuplicate = results.some(r => r.title === title);
                  if (!isDuplicate) {
                    results.push({
                      title,
                      url: jobUrl,
                      location: location || '',
                      workType: workType || ''
                    });
                  }
                }
              }
            }
          });
        });
        
        return results;
      }, {
        jobSelectors: jobListingSelectors,
        jobTerms: jobTerms,
        zohoSelectors: zohoSelectors
      });
      
      config.smartLog('steps', `Page evaluation returned ${jobData.length} potential jobs`);
      
      for (const job of jobData) {
        if (this.isValidJobTitle(job.title)) {
          let finalUrl = job.url;
          if (finalUrl && !finalUrl.startsWith('http')) {
            try {
              const pageUrl = await pageOrFrame.url();
              const baseUrl = new URL(pageUrl);
              finalUrl = new URL(finalUrl, baseUrl).href;
            } catch (e) {
              finalUrl = job.url;
            }
          }
          
          jobs.push({
            url: finalUrl || `${url}#job-${jobs.length}`,
            text: job.title,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.95,
            location: job.location,
            workType: job.workType,
            department: ''
          });
        }
      }
      
    } catch (error) {
      config.smartLog('fail', `Error in page evaluation: ${error.message}`);
    }
    
    return jobs;
  }

  async aggressiveJobExtraction(page) {
    const jobs = [];
    
    try {
      const jobTerms = this.getJobTerms();
      
      const aggressiveJobs = await page.evaluate((terms) => {
        const results = [];
        const allLinks = document.querySelectorAll('a');
        
        allLinks.forEach(link => {
          const text = link.textContent.trim();
          const href = link.href || link.getAttribute('href') || '';
          
          const hasJobKeyword = terms.some(term => 
            text.toLowerCase().includes(term.toLowerCase())
          );
          
          if (hasJobKeyword && text.length > 5 && text.length < 150) {
            results.push({
              title: text,
              url: href
            });
          }
        });
        
        return results;
      }, jobTerms);
      
      config.smartLog('steps', `Aggressive extraction found ${aggressiveJobs.length} potential jobs`);
      
      for (const job of aggressiveJobs) {
        if (this.isValidJobTitle(job.title)) {
          jobs.push({
            url: job.url || `${url}#job-${jobs.length}`,
            text: job.title,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.8,
            location: '',
            workType: '',
            department: ''
          });
        }
      }
    } catch (error) {
      config.smartLog('fail', `Error in aggressive extraction: ${error.message}`);
    }
    
    return jobs;
  }

  extractTextFromJobs(jobs) {
    return jobs.map(job => `${job.text} ${job.location} ${job.workType}`.trim()).join('\n');
  }

  isValidJobTitle(title) {
    if (!title || typeof title !== 'string') return false;
    
    const cleaned = title.trim();
    if (cleaned.length < 3 || cleaned.length > 150) return false;
    
    const dict = this.getDictionary();
    const exclusionPatterns = dict.exclusionPatterns || [];
    
    const defaultInvalidPatterns = [
      /^(home|about|contact|privacy|terms|login|register|search|filter|sort)$/i,
      /^[0-9]+$/,
      /^[^a-z]*$/i,
      /copyright/i,
      /terms and conditions/i,
      /privacy policy/i
    ];
    
    const allPatterns = [...defaultInvalidPatterns, ...exclusionPatterns];
    
    for (const pattern of allPatterns) {
      if (pattern.test(cleaned)) return false;
    }
    
    return true;
  }

  countJobTerms(text) {
    if (!text || typeof text !== 'string') return 0;
    
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
      description: 'Specialized headless scraper for ZohoRecruit sites with dynamic loading and popups',
      priority: this.priority,
      platforms: ['ZohoRecruit'],
      methods: ['zoho-recruit-headless'],
      features: [
        'Multilingual cookie and popup handling',
        'Dynamic job loading detection',
        'Smart content waiting strategies',
        'Multi-frame job extraction',
        'Aggressive fallback extraction',
        'Date-based table parsing',
        'Platform-agnostic job detection',
        'Duplicate job filtering',
        'Location and work type extraction'
      ],
      supportedLanguages: dict.getSupportedLanguages(),
      recommendedFor: [
        'ZohoRecruit sites with dynamic content',
        'Sites requiring popup handling',
        'Complex table-based job listings'
      ]
    };
  }
}

module.exports = ZohoRecruitHeadlessStep;