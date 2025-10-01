const axios = require('axios');
const cheerio = require('cheerio');
const { initBrowser } = require('../browserManager');
const { randomDelay, getRandomUserAgent } = require('../utils');
const { extractContentFromCheerio } = require('./helpers');
const { getCachedData, saveCache } = require('../cacheManager');
const dictionaries = require('../dictionaries');
const DomainProfiler = require('./DomainProfiler');
const config = require('../config');

class AdaptiveScraper {
  constructor() {
    if (AdaptiveScraper.instance) {
      return AdaptiveScraper.instance;
    }
    
    this.strategies = [
      { name: 'axios-simple', method: this.scrapeWithAxios, weight: 1.0 },
      { name: 'playwright-basic', method: this.scrapeWithPlaywright, weight: 0.8 },
      { name: 'robust-scraper', method: this.scrapeWithPlaywrightEnhanced, weight: 0.9 }
    ];
    
    this.domainStrategies = {};
    this.minTextLength = 200;
    this.minLinkCount = 3;
    this.domainProfiler = null;
    this.initialized = false;
    
    AdaptiveScraper.instance = this;
  }
  
  static getInstance() {
    if (!AdaptiveScraper.instance) {
      AdaptiveScraper.instance = new AdaptiveScraper();
    }
    return AdaptiveScraper.instance;
  }
  
  ensureInitialized() {
    if (!this.initialized) {
      this.domainProfiler = DomainProfiler.getInstance();
      this.initialized = true;
    }
  }
  
  detectJobPlatform(url, html) {
    const urlLower = url.toLowerCase();
    const htmlLower = html ? html.toLowerCase() : '';
    
    const knownJobPlatforms = dictionaries.knownJobPlatforms;
    
    for (const platform of knownJobPlatforms) {
      const urlMatch = platform.patterns.some(pattern => urlLower.includes(pattern.toLowerCase()));
      const htmlMatch = platform.indicators.some(indicator => htmlLower.includes(indicator.toLowerCase()));
      
      if (urlMatch || htmlMatch) {
        config.smartLog('platform', `Detected job platform: ${platform.name}`);
        return platform;
      }
    }
    
    return null;
  }
  
  isComplexDomain(url) {
    const urlLower = url.toLowerCase();
    const complexDomains = dictionaries.complexDomains;
    return complexDomains.some(domain => urlLower.includes(domain.toLowerCase()));
  }
  
  isJobURL(url) {
    const jobURLPatterns = dictionaries.jobURLPatterns;
    return jobURLPatterns.some(pattern => pattern.test(url));
  }
  
  hasJobTerms(text) {
    if (!text) return false;
    const textLower = text.toLowerCase();
    const jobTerms = dictionaries.jobTerms;
    const foundTerms = jobTerms.filter(term => textLower.includes(term.toLowerCase()));
    return foundTerms.length > 0;
  }
  
  getBestStrategy(domain, url) {
    const isComplex = this.isComplexDomain(url);
    const isJobUrl = this.isJobURL(url);
    
    if (this.domainStrategies[domain]) {
      config.smartLog('domain-profile', `Using preferred strategy for ${domain}: ${this.domainStrategies[domain]}`);
      return this.strategies.find(s => s.name === this.domainStrategies[domain]);
    }
    
    if (isComplex || isJobUrl) {
      config.smartLog('domain-profile', `Complex domain or job URL detected, preferring enhanced strategy`);
      return this.strategies.find(s => s.name === 'playwright-enhanced') || 
             [...this.strategies].sort((a, b) => b.weight - a.weight)[0];
    }
    
    return [...this.strategies].sort((a, b) => b.weight - a.weight)[0];
  }
  
  recordSuccess(domain, strategyName, quality) {
    config.smartLog('win', `Strategy ${strategyName} succeeded for ${domain} with quality ${quality}`);
    this.domainStrategies[domain] = strategyName;
    
    const strategy = this.strategies.find(s => s.name === strategyName);
    if (strategy) {
      strategy.weight = Math.min(strategy.weight + 0.1, 1.0);
    }
  }
  
  evaluateQuality(result) {
    if (!result) return 0;
    
    let score = 0;
    const method = result.method || 'unknown';
    
    if (result.text) {
      const textLength = result.text.length;
      const hasJobTerms = this.hasJobTerms(result.text);
      const textBonus = method === 'axios-simple' ? 0.15 : 0;
      const jobTermsBonus = hasJobTerms ? 0.2 : 0;
      
      if (textLength > this.minTextLength) {
        score += Math.min(textLength / 10000, 0.5) + textBonus + jobTermsBonus;
      }
    }
    
    if (result.links && result.links.length) {
      const linkCount = result.links.length;
      const jobLinks = result.links.filter(link => this.isJobURL(link.href || link.url || '')).length;
      const linkBonus = method === 'axios-simple' ? 0.1 : 0;
      const jobLinksBonus = jobLinks > 0 ? 0.15 : 0;
      
      if (linkCount > this.minLinkCount) {
        score += Math.min(linkCount / 50, 0.5) + linkBonus + jobLinksBonus;
      }
    }
    
    config.smartLog('steps', `Quality evaluation for ${method}: score=${score.toFixed(2)}, text=${result.text?.length || 0}, links=${result.links?.length || 0}`);
    
    return score;
  }
  
  async scrape(url) {
    this.ensureInitialized();
    
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      
      config.smartLog('steps', `Adaptive scraping for ${url}`);
      
      const profile = await this.domainProfiler.getDomainProfile(url);
      if (profile && profile.step && !profile.needsReprofiling) {
        config.smartLog('domain-profile', `Using profile optimization for ${domain}: ${profile.step}`);
      }
      
      const cachedData = await getCachedData(url);
      if (cachedData) {
        config.smartLog('cache', `Using cached data for ${url}`);
        await this.domainProfiler.recordHit(url, 'cache');
        return cachedData;
      }
      
      await this.domainProfiler.recordHit(url, 'scraping');
      
      const bestStrategy = this.getBestStrategy(domain, url);
      config.smartLog('steps', `Attempting with strategy: ${bestStrategy.name}`);
      
      let result = await bestStrategy.method.call(this, url);
      let quality = this.evaluateQuality(result);
      
      if (result && result.method === 'axios-simple' && quality > 0.3) {
        config.smartLog('win', `Accepting Axios result with score ${quality.toFixed(2)} > 0.3`);
        this.recordSuccess(domain, bestStrategy.name, quality);
        
        await saveCache(url, result);
        return result;
      }
      
      if (quality > 0.5) {
        this.recordSuccess(domain, bestStrategy.name, quality);
        await saveCache(url, result);
        return result;
      }
      
      config.smartLog('steps', `Insufficient quality (${quality}), trying other strategies`);
      
      const otherStrategies = this.strategies
        .filter(s => s.name !== bestStrategy.name)
        .sort((a, b) => b.weight - a.weight);
      
      for (const strategy of otherStrategies) {
        config.smartLog('steps', `Attempting with alternative strategy: ${strategy.name}`);
        
        const altResult = await strategy.method.call(this, url);
        const altQuality = this.evaluateQuality(altResult);
        
        if (altQuality > quality) {
          result = altResult;
          quality = altQuality;
          
          if (quality > 0.5) {
            this.recordSuccess(domain, strategy.name, quality);
            break;
          }
        }
      }
      
      if (result) {
        config.smartLog('win', `Using best available result (quality: ${quality})`);
        await saveCache(url, result);
        return result;
      }
      
      config.smartLog('fail', `Scraping failed for ${url}`);
      return null;
    } catch (error) {
      config.smartLog('fail', `Error in adaptive scraper: ${error.message}`);
      return null;
    }
  }
    
  async scrapeWithAxios(url) {
    config.smartLog('steps', `Scraping with Axios: ${url}`);
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 15000
      });
      
      const html = response.data;
      const $ = cheerio.load(html);
      
      const platform = this.detectJobPlatform(url, html);
      const extracted = extractContentFromCheerio($, url, platform);
      
      return {
        url,
        title: extracted.title,
        text: extracted.text,
        links: extracted.links,
        platform: platform?.name || null,
        scrapedAt: new Date().toISOString(),
        method: 'axios-simple'
      };
    } catch (error) {
      config.smartLog('fail', `Axios error: ${error.message}`);
      return null;
    }
  }
  
  async scrapeWithPlaywright(url) {
    config.smartLog('steps', `Scraping with basic Playwright: ${url}`);
    const browser = await initBrowser();
    
    try {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: getRandomUserAgent()
      });
      
      const page = await context.newPage();
      
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await randomDelay(2000, 4000);
        
        await this.handleCookieConsent(page);
        
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight * 0.8);
        });
        
        await randomDelay(1000, 2000);
        
        const html = await page.content();
        const $ = cheerio.load(html);
        
        const platform = this.detectJobPlatform(url, html);
        const extracted = extractContentFromCheerio($, url, platform);
        
        return {
          url,
          title: extracted.title,
          text: extracted.text,
          links: extracted.links,
          platform: platform?.name || null,
          scrapedAt: new Date().toISOString(),
          method: 'playwright-basic'
        };
      } catch (error) {
        config.smartLog('fail', `Basic Playwright error: ${error.message}`);
        return null;
      } finally {
        await page.close();
      }
    } catch (error) {
      config.smartLog('fail', `Critical Playwright error: ${error.message}`);
      return null;
    }
  }
  
  async scrapeWithPlaywrightEnhanced(url) {
    config.smartLog('steps', `Scraping with enhanced Playwright: ${url}`);
    const browser = await initBrowser();
    
    try {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: getRandomUserAgent()
      });
      
      const page = await context.newPage();
      
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await randomDelay(3000, 5000);
        
        await this.handleCookieConsent(page);
        await this.handleDynamicContent(page);
        await this.handleShowMoreButtons(page);
        
        const html = await page.content();
        const $ = cheerio.load(html);
        
        const platform = this.detectJobPlatform(url, html);
        const extracted = extractContentFromCheerio($, url, platform);
        
        const selectedText = await this.getSelectedText(page);
        
        return {
          url,
          title: extracted.title,
          text: selectedText || extracted.text,
          links: extracted.links,
          platform: platform?.name || null,
          scrapedAt: new Date().toISOString(),
          method: 'playwright-enhanced'
        };
      } catch (error) {
        config.smartLog('fail', `Enhanced Playwright error: ${error.message}`);
        return null;
      } finally {
        await page.close();
      }
    } catch (error) {
      config.smartLog('fail', `Critical enhanced Playwright error: ${error.message}`);
      return null;
    }
  }
  
  async handleCookieConsent(page) {
    try {
      const cookieSelectors = dictionaries.cookieSelectors;
      for (const selector of cookieSelectors.slice(0, 10)) {
        try {
          const element = await page.$(selector);
          if (element) {
            config.smartLog('steps', `Found cookie consent with selector: ${selector}`);
            await element.click();
            await randomDelay(1000, 2000);
            break;
          }
        } catch (e) {
          continue;
        }
      }
    } catch (error) {
      config.smartLog('fail', `Cookie consent handling failed: ${error.message}`);
    }
  }
  
  async handleDynamicContent(page) {
    try {
      const dynamicContentIndicators = dictionaries.dynamicContentIndicators;
      const hasDynamicContent = await page.evaluate((indicators) => {
        return indicators.some(selector => document.querySelector(selector));
      }, dynamicContentIndicators.slice(0, 10));
      
      if (hasDynamicContent) {
        config.smartLog('steps', `Dynamic content detected, waiting longer`);
        await randomDelay(3000, 5000);
        
        await page.evaluate(() => {
          return new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 300;
            let timer = setInterval(() => {
              window.scrollBy(0, distance);
              totalHeight += distance;
              
              if (totalHeight >= document.body.scrollHeight) {
                clearInterval(timer);
                window.scrollTo(0, 0);
                setTimeout(resolve, 1000);
              }
            }, 200);
          });
        });
      }
    } catch (error) {
      config.smartLog('fail', `Dynamic content handling failed: ${error.message}`);
    }
  }
  
  async handleShowMoreButtons(page) {
    try {
      let attempts = 0;
      const maxAttempts = 3;
      const showMoreSelectors = dictionaries.showMoreSelectors;
      
      while (attempts < maxAttempts) {
        let buttonFound = false;
        
        for (const selector of showMoreSelectors.slice(0, 15)) {
          try {
            const elements = await page.$$(selector);
            
            for (const element of elements) {
              const text = await element.textContent();
              const isShowMore = this.isShowMoreButton(text);
              
              if (isShowMore) {
                config.smartLog('steps', `Clicking show more button: ${text}`);
                await element.click();
                await randomDelay(2000, 4000);
                buttonFound = true;
                break;
              }
            }
            
            if (buttonFound) break;
          } catch (e) {
            continue;
          }
        }
        
        if (!buttonFound) break;
        attempts++;
      }
    } catch (error) {
      config.smartLog('fail', `Show more button handling failed: ${error.message}`);
    }
  }
  
  isShowMoreButton(text) {
    if (!text) return false;
    const textLower = text.toLowerCase().trim();
    
    const showMorePatterns = dictionaries.showMorePatterns;
    const buttonPatterns = dictionaries.buttonPatterns;
    
    return showMorePatterns.regex.test(textLower) && 
           !buttonPatterns.negative.english.test(textLower) &&
           !buttonPatterns.negative.french.test(textLower);
  }
  
  async getSelectedText(page) {
    try {
      await page.keyboard.press('Control+a');
      await randomDelay(1000, 2000);
      
      const selectedText = await page.evaluate(() => {
        const selection = window.getSelection();
        return selection.toString();
      });
      
      return selectedText;
    } catch (error) {
      config.smartLog('fail', `Text selection failed: ${error.message}`);
      return null;
    }
  }
}

AdaptiveScraper.instance = null;

module.exports = AdaptiveScraper;