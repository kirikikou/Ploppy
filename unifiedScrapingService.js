const { chromium } = require('playwright');
const PlatformDetector = require('./platformDetector');
const PlatformSpecificScrapers = require('./PlatformSpecificScrapers');
const StepBasedScraper = require('./StepBasedScraper');
const DomainProfiler = require('./DomainProfiler');
const dictionaries = require('../dictionaries');
const config = require('../config');
const fs = require('fs').promises;
const path = require('path');

class UnifiedScrapingService {
  constructor() {
    this.platformSpecificScrapers = new PlatformSpecificScrapers();
    this.genericScraper = new StepBasedScraper();
    this.domainProfiler = new DomainProfiler();
  }

  isJobRelatedPage(url, html) {
    const urlLower = url.toLowerCase();
    const htmlLower = html ? html.toLowerCase() : '';
    
    const jobURLPatterns = dictionaries.jobURLPatterns;
    const hasJobURLPattern = jobURLPatterns.some(pattern => pattern.test(urlLower));
    if (hasJobURLPattern) return true;
    
    if (html) {
      const jobTerms = dictionaries.jobTerms;
      const jobTermCount = jobTerms.filter(term => 
        htmlLower.includes(term.toLowerCase())
      ).length;
      return jobTermCount >= 3;
    }
    
    return false;
  }

  detectBlockingContent(page) {
    const blockingContentSelectors = dictionaries.blockingContentSelectors;
    return Promise.race([
      page.locator(blockingContentSelectors.join(', ')).first().isVisible({ timeout: 2000 }),
      new Promise(resolve => setTimeout(() => resolve(false), 2000))
    ]).catch(() => false);
  }

  async handleCookiesAndOverlays(page) {
    try {
      const cookieSelectors = dictionaries.cookieSelectors;
      const cookieSelector = cookieSelectors.join(', ');
      const cookieButton = page.locator(cookieSelector).first();
      
      if (await cookieButton.isVisible({ timeout: 3000 })) {
        await cookieButton.click({ timeout: 2000 });
        config.smartLog('steps', 'Cookie banner handled');
        await page.waitForTimeout(1000);
      }
    } catch (error) {
      config.smartLog('steps', 'No cookie banner found or error handling it');
    }
  }

  async detectEmptyContent(page) {
    try {
      const emptyContentIndicators = dictionaries.emptyContentIndicators;
      const emptySelector = emptyContentIndicators.join(', ');
      return await page.locator(emptySelector).first().isVisible({ timeout: 2000 });
    } catch (error) {
      return false;
    }
  }

  async enhancedPlatformDetection(url, html) {
    let platform = PlatformDetector.detectPlatform(url, html);
    
    if (!platform && html) {
      const knownJobPlatforms = dictionaries.knownJobPlatforms;
      for (const platformInfo of knownJobPlatforms) {
        const hasPattern = platformInfo.patterns.some(pattern => 
          url.includes(pattern) || html.includes(pattern)
        );
        const hasIndicator = platformInfo.indicators.some(indicator => 
          html.includes(indicator)
        );
        
        if (hasPattern || hasIndicator) {
          platform = platformInfo.name;
          config.smartLog('platform', `Enhanced detection found: ${platform}`);
          break;
        }
      }
    }
    
    return platform;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Unified scraping service: ${url}`);
    
    const sessionStart = Date.now();
    let sessionData = {
      stepUsed: null,
      wasHeadless: false,
      startTime: sessionStart,
      endTime: null,
      success: false,
      contentText: '',
      errorMessage: null,
      jobsFound: 0,
      platform: null
    };
    
    let scrapingError = null;
    let result = null;
    
    try {
      let platform = await this.enhancedPlatformDetection(url);
      let html = null;
      
      if (!platform) {
        config.smartLog('platform', 'No platform detected from URL, trying to fetch page for detection');
        sessionData.wasHeadless = true;
        
        const browser = await chromium.launch({
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=site-per-process',
            '--disable-web-security',
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials'
          ],
          timeout: 30000
        });
        
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          await this.handleCookiesAndOverlays(page);
          
          const isBlocked = await this.detectBlockingContent(page);
          if (isBlocked) {
            config.smartLog('fail', 'Blocking content detected (CAPTCHA/Rate limit)');
            sessionData.errorMessage = 'CAPTCHA or rate limiting detected';
            sessionData.endTime = Date.now();
            sessionData.stepUsed = 'platform_detection_blocked';
            scrapingError = new Error(sessionData.errorMessage);
            await this.domainProfiler.recordScrapingSession(url, sessionData);
            
            if (config.shouldExportDebug(result, scrapingError, 'UnifiedScrapingService')) {
              const debugPromises = [
                page.screenshot({ fullPage: true }).then(screenshot => 
                  fs.writeFile(
                    path.join(config.DEBUG_DIR, `UnifiedService-BLOCKED-${new URL(url).hostname}-${Date.now()}.png`), 
                    screenshot
                  )
                ).catch(() => {}),
                page.content().then(html => 
                  fs.writeFile(
                    path.join(config.DEBUG_DIR, `UnifiedService-BLOCKED-${new URL(url).hostname}-${Date.now()}.html`), 
                    html
                  )
                ).catch(() => {})
              ];
              await Promise.all(debugPromises).catch(() => {});
            }
            
            return { status: 'blocked', reason: sessionData.errorMessage };
          }
          
          html = await page.content();
          sessionData.contentText = html;
          platform = await this.enhancedPlatformDetection(url, html);
          sessionData.platform = platform;
          
          if (!this.isJobRelatedPage(url, html)) {
            config.smartLog('fail', 'Page content not related to jobs');
            sessionData.errorMessage = 'Page content not related to jobs';
            sessionData.endTime = Date.now();
            sessionData.stepUsed = 'not_job_related';
            scrapingError = new Error(sessionData.errorMessage);
            await this.domainProfiler.recordScrapingSession(url, sessionData);
            return { status: 'not_job_related', reason: sessionData.errorMessage };
          }
          
          const isEmpty = await this.detectEmptyContent(page);
          if (isEmpty) {
            config.smartLog('steps', 'Empty job content detected');
            sessionData.errorMessage = 'No jobs found on page';
            sessionData.endTime = Date.now();
            sessionData.stepUsed = 'empty_content';
            await this.domainProfiler.recordScrapingSession(url, sessionData);
            return { status: 'empty', reason: sessionData.errorMessage };
          }
          
          if (platform) {
            config.smartLog('platform', `Platform detected from HTML: ${platform}`);
          }
          
          await page.close();
        } catch (error) {
          config.smartLog('fail', `Error detecting platform: ${error.message}`);
          sessionData.errorMessage = `Platform detection error: ${error.message}`;
          sessionData.endTime = Date.now();
          sessionData.stepUsed = 'platform_detection_error';
          scrapingError = error;
          await this.domainProfiler.recordScrapingSession(url, sessionData);
        } finally {
          await browser.close();
        }
      }
      
      if (platform) {
        config.smartLog('platform', `Using platform-specific scraper: ${platform}`);
        sessionData.stepUsed = `PlatformSpecific_${platform}`;
        sessionData.wasHeadless = true;
        
        const browser = await chromium.launch({
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=site-per-process',
            '--disable-web-security',
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '--disable-setuid-sandbox',
            '--no-sandbox'
          ],
          timeout: 60000
        });
        
        try {
          result = await this.platformSpecificScrapers.scrape(url, platform, browser, options);
          
          if (result && result.links && result.links.length > 0) {
            config.smartLog('win', `Platform-specific scraper (${platform}) successful with ${result.links.length} links`);
            sessionData.success = true;
            sessionData.jobsFound = result.links.length;
            sessionData.contentText = result.text || '';
            sessionData.endTime = Date.now();
            
            await this.domainProfiler.recordScrapingSession(url, sessionData);
            return result;
          } else {
            config.smartLog('fail', 'Platform-specific scraper returned no links, trying generic scraper');
            sessionData.stepUsed = null;
            scrapingError = new Error('Platform-specific scraper returned no results');
          }
        } catch (error) {
          sessionData.errorMessage = `Platform scraper error: ${error.message}`;
          scrapingError = error;
        } finally {
          await browser.close();
        }
      }
      
      config.smartLog('steps', 'Using generic StepBasedScraper');
      result = await this.genericScraper.scrape(url, {
        ...options,
        skipProfiling: true
      });
      
      if (result) {
        config.smartLog('win', 'StepBasedScraper successful');
        return result;
      }
      
      config.smartLog('fail', `All scraping methods failed for ${url}`);
      sessionData.errorMessage = 'All scraping methods failed';
      sessionData.endTime = Date.now();
      sessionData.stepUsed = sessionData.stepUsed || 'all_methods_failed';
      scrapingError = new Error(sessionData.errorMessage);
      await this.domainProfiler.recordScrapingSession(url, sessionData);
      
      if (config.shouldExportDebug(result, scrapingError, 'UnifiedScrapingService')) {
        try {
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `UnifiedService-FAIL-${new URL(url).hostname}-${Date.now()}.json`), 
            JSON.stringify({ url, sessionData, error: scrapingError.message }, null, 2)
          );
        } catch (e) {}
      }
      
      return null;
      
    } catch (error) {
      config.smartLog('fail', `Error scraping ${url}: ${error.message}`);
      sessionData.errorMessage = error.message;
      sessionData.endTime = Date.now();
      sessionData.stepUsed = sessionData.stepUsed || 'scraping_error';
      scrapingError = error;
      await this.domainProfiler.recordScrapingSession(url, sessionData);
      
      if (config.shouldExportDebug(result, scrapingError, 'UnifiedScrapingService')) {
        try {
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `UnifiedService-ERROR-${new URL(url).hostname}-${Date.now()}.json`), 
            JSON.stringify({ url, sessionData, error: error.message }, null, 2)
          );
        } catch (e) {}
      }
      
      return null;
    }
  }

  async close() {
    try {
      if (this.genericScraper && this.genericScraper.close) {
        await this.genericScraper.close().catch(e => config.smartLog('fail', `Error closing StepBasedScraper: ${e.message}`));
      }
    } catch (error) {
      config.smartLog('fail', `Error closing UnifiedScrapingService resources: ${error.message}`);
    }
  }
}

module.exports = UnifiedScrapingService;