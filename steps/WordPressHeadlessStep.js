const { chromium } = require('playwright');
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const config = require('../../config');
const path = require('path');
const fs = require('fs').promises;

class WordPressHeadlessStep extends BaseScraperStep {
  constructor() {
    super('wordpress-headless', 3);
  }
  
  async isApplicable(url, context = {}) {
    if (context.detectedPlatform !== 'WordPress') return false;
    
    if (context.previousStepResult) {
      const prevResult = context.previousStepResult;
      const hasLimitedContent = !prevResult.jobs || prevResult.jobs.length === 0;
      const hasJavaScriptIndicators = prevResult.text && 
        (prevResult.text.includes('javascript') || prevResult.text.length < 200);
      
      return hasLimitedContent || hasJavaScriptIndicators;
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
        args: [...config.playwrightArgs, '--disable-dev-shm-usage', '--disable-extensions']
      });
      
      context = await browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        locale: 'en-US'
      });
      
      page = await context.newPage();
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8,es;q=0.7,de;q=0.6'
      });
      
      await page.goto(url, { 
        waitUntil: 'networkidle', 
        timeout: 30000 
      });
      
      await this.handleInitialLoad(page);
      await this.removeBlockingContent(page);
      await this.handleWordPressCookies(page);
      await this.handleWordPressFilters(page);
      await this.handleDynamicContent(page);
      await this.handlePagination(page);
      
      const content = await this.extractWordPressContent(page, url);
      
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
  
  async handleInitialLoad(page) {
    config.smartLog('steps', `Waiting for initial content load`);
    
    const jobListingSelectors = this.getJobListingSelectors();
    const dynamicContentZones = this.getDynamicContentZones();
    
    const universalSelectors = [
      ...jobListingSelectors,
      ...dynamicContentZones
    ];
    
    try {
      await Promise.race([
        page.waitForSelector(universalSelectors.join(','), { timeout: 15000 }),
        page.waitForTimeout(8000)
      ]);
    } catch (e) {
      config.smartLog('steps', `No specific content selectors found, continuing...`);
    }
    
    await this.waitForLoadingToComplete(page);
  }
  
  async waitForLoadingToComplete(page) {
    const loadingIndicators = this.getLoadingIndicators();
    const blockingContentSelectors = this.getBlockingContentSelectors();
    
    const allLoadingSelectors = [
      ...loadingIndicators,
      ...blockingContentSelectors
    ];
    
    try {
      await Promise.all(
        allLoadingSelectors.map(selector =>
          page.waitForSelector(selector, { state: 'detached', timeout: 3000 }).catch(() => {})
        )
      );
    } catch (e) {}
    
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  
  async removeBlockingContent(page) {
    const blockingContentSelectors = this.getBlockingContentSelectors();
    
    try {
      await page.evaluate((selectors) => {
        selectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            if (el && (el.style.position === 'fixed' || 
                      el.style.position === 'absolute' ||
                      el.classList.contains('modal') ||
                      el.classList.contains('popup') ||
                      el.style.zIndex > 1000)) {
              el.remove();
            }
          });
        });
      }, blockingContentSelectors);
    } catch (e) {}
  }
  
  async handleWordPressFilters(page) {
    config.smartLog('steps', `Handling WordPress filters`);
    
    try {
      const filterKeywords = this.getFilterKeywords();
      const searchFilterSelectors = this.getSearchFilterSelectors();
      
      const filterData = await page.evaluate((data) => {
        const { filterKeywords, filterSelectors } = data;
        const buttons = [];
        const universalSelectors = [
          'button', '[role="button"]', 'div[onclick]', 'span[onclick]',
          '.filter', '.dropdown', '.select', '.toggle',
          '[class*="filter"]', '[id*="filter"]',
          '[class*="department"]', '[id*="department"]',
          '[class*="location"]', '[id*="location"]',
          '[class*="category"]', '[id*="category"]',
          '.wp-block-button', 'select', 'option'
        ];
        
        const allElements = document.querySelectorAll(universalSelectors.join(','));
        
        for (const element of allElements) {
          const text = (element.textContent || '').trim().toLowerCase();
          const id = (element.id || '').toLowerCase();
          const className = (element.className || '').toLowerCase();
          
          const isRelevant = filterKeywords.some(keyword => 
            text.includes(keyword.toLowerCase()) || id.includes(keyword.toLowerCase()) || className.includes(keyword.toLowerCase())
          );
          
          if (isRelevant && element.offsetParent) {
            let selector = element.tagName.toLowerCase();
            if (element.id) selector += `#${element.id}`;
            else if (element.className) selector += `.${element.className.split(' ')[0]}`;
            
            buttons.push({
              text: element.textContent.trim(),
              selector: selector,
              clickable: true
            });
          }
        }
        
        return buttons.slice(0, 5);
      }, { filterKeywords, filterSelectors: searchFilterSelectors });
      
      for (const button of filterData) {
        try {
          await page.click(button.selector, { timeout: 5000 });
          await randomDelay(2000, 4000);
          config.smartLog('steps', `Clicked filter: ${button.text}`);
          break;
        } catch (e) {
          config.smartLog('retry', `Could not click filter: ${button.text}`);
        }
      }
      
    } catch (error) {
      config.smartLog('fail', `Filter handling error: ${error.message}`);
    }
  }
  
  async handleDynamicContent(page) {
    config.smartLog('steps', `Checking if dynamic content expansion is needed`);
    
    const needsExpansion = await page.evaluate(() => {
      const indicators = [
        ...Array.from(document.querySelectorAll('[style*="overflow: hidden"], [style*="overflow:hidden"]'))
          .filter(el => {
            const style = window.getComputedStyle(el);
            return style.overflow === 'hidden' && el.scrollHeight > el.clientHeight;
          }),
        
        ...Array.from(document.querySelectorAll('.truncated, .collapsed, .excerpt, .preview, .teaser')),
        
        ...Array.from(document.querySelectorAll('*')).filter(el => {
          const style = window.getComputedStyle(el);
          return style.textOverflow === 'ellipsis';
        })
      ];
      
      return indicators.length > 0;
    });
    
    if (!needsExpansion) {
      config.smartLog('steps', `No hidden content detected, skipping expansion`);
      return;
    }
    
    await this.handleShowMoreButtons(page);
  }

  async handleShowMoreButtons(page) {
    const showMoreSelectors = this.getShowMoreSelectors();
    const showMoreTextSelectors = this.getShowMoreTextSelectors();
    
    const validButtons = await page.evaluate((data) => {
      const { showMoreSelectors, showMoreTextSelectors } = data;
      const buttons = [];
      
      showMoreSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el.offsetParent) {
            buttons.push({
              selector: selector,
              text: el.textContent.trim(),
              priority: 1
            });
          }
        });
      });
      
      if (buttons.length === 0) {
        const maxLength = 25;
        const allButtons = document.querySelectorAll('button, [role="button"], a, div[onclick], span[onclick]');
        
        allButtons.forEach(button => {
          const text = button.textContent.trim();
          if (text.length > maxLength) return;
          
          const isPositive = showMoreTextSelectors.some(term => 
            text.toLowerCase().includes(term.toLowerCase())
          );
          
          const negativePatterns = ['apply', 'submit', 'subscribe', 'register', 'login'];
          const isNegative = negativePatterns.some(pattern => 
            text.toLowerCase().includes(pattern)
          );
          
          if (isPositive && !isNegative && button.offsetParent) {
            let selector = button.tagName.toLowerCase();
            if (button.id) selector += `#${button.id}`;
            else if (button.className) selector += `.${button.className.split(' ')[0]}`;
            
            buttons.push({
              selector: selector,
              text: text,
              priority: 2
            });
          }
        });
      }
      
      return buttons.sort((a, b) => a.priority - b.priority).slice(0, 3);
    }, { showMoreSelectors, showMoreTextSelectors });

    let successfulClicks = 0;
    const maxClicks = 3;
    
    for (const buttonInfo of validButtons) {
      if (successfulClicks >= maxClicks) break;
      
      try {
        const element = await page.$(buttonInfo.selector);
        if (!element) continue;
        
        await element.click();
        await page.waitForTimeout(2000);
        
        successfulClicks++;
        config.smartLog('win', `Successfully clicked: "${buttonInfo.text}"`);
        
        const stillHasHidden = await page.evaluate(() => {
          return document.querySelectorAll('.truncated, .collapsed, [style*="overflow: hidden"]').length > 0;
        });
        
        if (!stillHasHidden) {
          config.smartLog('steps', `All content expanded, stopping`);
          break;
        }
      } catch (e) {
        config.smartLog('retry', `Failed to click: ${buttonInfo.text}`);
      }
    }

    if (successfulClicks === 0) {
      await this.handleInfiniteScroll(page);
    }
  }
  
  async handleWordPressCookies(page) {
    config.smartLog('steps', `Checking for cookie notices`);
    
    const cookieSelectors = this.getCookieSelectors();
    const cookieTextSelectors = this.getCookieTextSelectors();
    
    const hasCookieNotice = await page.evaluate((cookieTextSelectors) => {
      const elements = document.querySelectorAll('div, section, aside');
      
      for (const el of elements) {
        const text = (el.textContent || '').toLowerCase();
        const hasKeyword = cookieTextSelectors.some(kw => text.includes(kw.toLowerCase()));
        const isVisible = el.offsetParent !== null;
        const isOverlay = window.getComputedStyle(el).position === 'fixed' || 
                         window.getComputedStyle(el).zIndex > 1000;
        
        if (hasKeyword && isVisible && (isOverlay || el.getBoundingClientRect().height > 50)) {
          return true;
        }
      }
      return false;
    }, cookieTextSelectors);
    
    if (!hasCookieNotice) {
      config.smartLog('steps', `No cookie notice detected`);
      return;
    }
    
    try {
      const cookieButtonSelectors = [...cookieSelectors];
      
      for (const selector of cookieButtonSelectors) {
        try {
          const element = await page.$(selector);
          if (element && await element.isVisible()) {
            await element.click();
            config.smartLog('steps', `Clicked cookie button: ${selector}`);
            await page.waitForTimeout(1000);
            return;
          }
        } catch (e) {}
      }
      
      const textBasedButtons = await page.evaluate((cookieTextSelectors) => {
        const buttons = [];
        const allButtons = document.querySelectorAll('button, a[role="button"], [role="button"]');
        
        for (const button of allButtons) {
          const text = button.textContent.trim().toLowerCase();
          const isAcceptButton = cookieTextSelectors.some(term => 
            text.includes(term.toLowerCase())
          );
          
          if (isAcceptButton && text.length < 50) {
            buttons.push({
              selector: button.tagName.toLowerCase() + (button.id ? `#${button.id}` : '') + (button.className ? `.${button.className.split(' ')[0]}` : ''),
              text: button.textContent.trim()
            });
          }
        }
        return buttons.slice(0, 3);
      }, cookieTextSelectors);
      
      for (const buttonInfo of textBasedButtons) {
        try {
          await page.click(buttonInfo.selector);
          config.smartLog('steps', `Clicked text-based cookie button: ${buttonInfo.text}`);
          await page.waitForTimeout(1000);
          return;
        } catch (e) {}
      }
      
    } catch (error) {
      config.smartLog('fail', `Cookie handling error: ${error.message}`);
    }
  }

  async countJobElements(page) {
    const jobSelectors = this.getJobListingSelectors();
    
    return await page.evaluate((jobSelectors) => {
      let count = 0;
      jobSelectors.forEach(selector => {
        count += document.querySelectorAll(selector).length;
      });
      return count;
    }, jobSelectors);
  }
  
  async handleInfiniteScroll(page) {
    const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
    const beforeJobCount = await this.countJobElements(page);
    
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    
    await randomDelay(4000, 6000);
    
    const afterHeight = await page.evaluate(() => document.body.scrollHeight);
    const afterJobCount = await this.countJobElements(page);
    
    return afterHeight > beforeHeight || afterJobCount > beforeJobCount;
  }
  
  async handlePagination(page) {
    config.smartLog('steps', `Handling pagination`);
    
    const paginationSelectors = this.getPaginationSelectors();
    const paginationTextSelectors = this.getPaginationTextSelectors();
    
    let pageCount = 1;
    const maxPages = 3;
    
    while (pageCount < maxPages) {
      let navigated = false;
      
      for (const selector of paginationSelectors) {
        try {
          const links = await page.$$(selector);
          
          for (const link of links) {
            const text = await link.textContent();
            const href = await link.getAttribute('href');
            const classes = await link.getAttribute('class') || '';
            const disabled = await link.getAttribute('disabled');
            
            const isNextLink = paginationTextSelectors.some(pattern => 
              text?.toLowerCase().includes(pattern.toLowerCase()) || href?.includes('page')
            );
            
            const isNotDisabled = !classes.includes('current') && 
                                 !classes.includes('disabled') && 
                                 !disabled;
            
            if (isNextLink && isNotDisabled && text && text.trim()) {
              await link.click();
              await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
              await randomDelay(3000, 5000);
              
              navigated = true;
              pageCount++;
              config.smartLog('steps', `Navigated to page ${pageCount}`);
              break;
            }
          }
          
          if (navigated) break;
        } catch (e) {}
      }
      
      if (!navigated) break;
    }
  }
  
  async extractWordPressContent(page, url) {
    const jobListingSelectors = this.getJobListingSelectors();
    const jobTerms = this.getJobTerms();
    
    const content = await page.evaluate((data) => {
      const { jobListingSelectors, jobTerms } = data;
      const result = {
        title: document.title,
        text: '',
        links: []
      };
      
      const contentSelectors = [
        '.entry-content', '.main-content', '#main-content', '.content',
        'article', '.site-main', '.page-content', '.post-content',
        'main', '.primary', '#primary', '.container'
      ];
      
      let mainContent = null;
      for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          mainContent = element;
          break;
        }
      }
      
      if (mainContent) {
        const clone = mainContent.cloneNode(true);
        const scriptsAndStyles = clone.querySelectorAll('script, style, nav, footer, .navigation, .menu');
        scriptsAndStyles.forEach(el => el.remove());
        result.text = clone.innerText || clone.textContent || '';
      } else {
        result.text = document.body.innerText || document.body.textContent || '';
      }
      
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
      
      const universalJobSelectors = [
        ...jobListingSelectors,
        '.job', '.job-item', '.job-listing', '.job-post', '.job-card',
        '.career-item', '.position', '.position-item', '.opening', '.vacancy',
        '.employment', '.opportunity', '.role', '.post-job',
        '[class*="job-"]', '[id*="job-"]', '[class*="career"]', '[id*="career"]',
        '[class*="position"]', '[id*="position"]', '[class*="employ"]',
        '.jobs-list .job', '.careers-list .career', '.positions-list .position',
        '.wp-block-group .job', '.entry .job', '.group .job',
        '.listing', '.offer', '.work', 'tr[class*="job"]', 'li[class*="job"]'
      ];
      
      const processedLinks = new Set();
      
      universalJobSelectors.forEach(selector => {
        const jobElements = document.querySelectorAll(selector);
        jobElements.forEach(job => {
          const titleSelectors = [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            '.title', '.job-title', '.position-title', '.role-title',
            '[class*="title"]', '[class*="heading"]',
            '.name', '.job-name', '.position-name',
            'a[href*="job"]', 'a[href*="career"]', 'a[href*="position"]'
          ];
          
          let titleElement = null;
          for (const titleSelector of titleSelectors) {
            titleElement = job.querySelector(titleSelector);
            if (titleElement && titleElement.textContent.trim()) break;
          }
          
          const linkElement = job.querySelector('a[href]');
          
          if (titleElement && titleElement.textContent.trim() && isValidJobTitle(titleElement.textContent.trim())) {
            const title = titleElement.textContent.trim();
            const jobUrl = linkElement ? linkElement.href : '';
            
            if (jobUrl && !processedLinks.has(jobUrl)) {
              processedLinks.add(jobUrl);
              
              result.links.push({
                url: jobUrl,
                text: title,
                isJobPosting: true,
                matchedJobTitle: title
              });
            }
          }
        });
      });
      
      const additionalLinkSelectors = [
        'a[href*="job"]', 'a[href*="career"]', 'a[href*="position"]',
        'a[href*="employ"]', 'a[href*="work"]', 'a[href*="apply"]',
        'a[href*="opportunity"]', 'a[href*="opening"]', 'a[href*="vacancy"]'
      ];
      
      additionalLinkSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(link => {
          const href = link.href;
          const text = link.textContent.trim();
          
          if (href && text && !href.startsWith('javascript:') && href.includes('http') && !processedLinks.has(href)) {
            const isJobRelated = jobTerms.some(term => 
              href.toLowerCase().includes(term) || text.toLowerCase().includes(term)
            );
            
            if (isJobRelated && isValidJobTitle(text)) {
              result.links.push({
                url: href,
                text: text
              });
              processedLinks.add(href);
            }
          }
        });
      });
      
      return result;
    }, { jobListingSelectors, jobTerms });

    return {
      url,
      ...content,
      scrapedAt: new Date().toISOString(),
      method: this.name,
      platform: 'WordPress',
      detectedPlatform: 'WordPress'
    };
  }
  
  isValidWordPressContent(content) {
    if (!content) return false;
    
    const hasContent = content.text && content.text.length > 100;
    const hasJobLinks = content.links && content.links.length > 0;
    
    config.smartLog('steps', `Content validation - Text: ${content.text?.length || 0} chars, Links: ${content.links?.length || 0}`);
    
    return hasContent || hasJobLinks;
  }
}

module.exports = WordPressHeadlessStep;