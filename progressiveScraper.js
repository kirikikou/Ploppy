const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;
const { randomDelay, getRandomUserAgent } = require('../utils');
const { extractContentFromCheerio } = require('./helpers');
const { getCachedData, saveCache } = require('../cacheManager');
const config = require('../config');
const dictionaries = require('../dictionaries');

class ProgressiveScraper {
  constructor() {
    this.browser = null;
    this.defaultHeaders = {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8'
    };
    this.knownJobPlatforms = dictionaries.knownJobPlatforms;
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: config.playwrightArgs
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
    config.smartLog('scraper', `Starting progressive scrape for: ${url}`);
    
    try {
      const detectedPlatform = this.detectJobPlatform(url);
      if (detectedPlatform) {
        config.smartLog('platform', `Detected job platform: ${detectedPlatform.name}`);
        
        if (detectedPlatform.directMethod) {
          config.smartLog('platform', `Using direct headless rendering for ${detectedPlatform.name}`);
          const result = await this.headlessRendering(url, { specialPlatform: detectedPlatform });
          if (this.isResultValid(result, 'headless')) {
            config.smartLog('scraper', `Direct headless rendering successful for ${url}`);
            return result;
          }
        } else if (detectedPlatform.iframeMethod) {
          config.smartLog('platform', `Using iframe-aware headless rendering for ${detectedPlatform.name}`);
          const result = await this.iframeAwareRendering(url, { specialPlatform: detectedPlatform });
          if (this.isResultValid(result, 'headless')) {
            config.smartLog('scraper', `Iframe-aware rendering successful for ${url}`);
            return result;
          }
        }
      }
      
      let result = await this.simpleHTTPRequest(url);
      if (this.isResultValid(result, 'simple')) {
        config.smartLog('scraper', `Simple HTTP request successful for ${url}`);
        return result;
      }
      
      const suspectJS = result?.suspectJS;
      result = await this.lightweightVersions(url, suspectJS);
      if (this.isResultValid(result, 'light')) {
        config.smartLog('scraper', `Lightweight version successful for ${url}`);
        return result;
      }
      
      result = await this.headlessRendering(url);
      if (this.isResultValid(result, 'headless')) {
        config.smartLog('scraper', `Headless rendering successful for ${url}`);
        return result;
      }
      
      result = await this.iframeAwareRendering(url);
      if (this.isResultValid(result, 'iframe')) {
        config.smartLog('scraper', `Iframe-aware rendering successful for ${url}`);
        return result;
      }
      
      config.smartLog('scraper', `All scraping methods failed for ${url}`);
      return null;
    } catch (error) {
      config.smartLog('fail', `Error in progressive scrape: ${error.message}`);
      config.smartLog('fail', error.stack);
      return null;
    }
  }
  
  detectJobPlatform(url) {
    const knownJobPlatforms = dictionaries.knownJobPlatforms;
    for (const platform of knownJobPlatforms) {
      if (platform.patterns.some(pattern => url.includes(pattern))) {
        return platform;
      }
    }
    return null;
  }
  
  detectJobPlatformFromContent(html, url) {
    const $ = cheerio.load(html);
    
    for (const platform of this.knownJobPlatforms) {
      if (platform.indicators) {
        for (const indicator of platform.indicators) {
          if (html.includes(indicator) || $(indicator).length > 0) {
            config.smartLog('platform', `Platform ${platform.name} detected via indicator: ${indicator}`);
            return platform;
          }
        }
      }
      
      if (platform.apiPatterns) {
        for (const apiPattern of platform.apiPatterns) {
          if (html.includes(apiPattern)) {
            config.smartLog('platform', `Platform ${platform.name} detected via API pattern: ${apiPattern}`);
            return platform;
          }
        }
      }
    }
    
    return null;
  }
  
  async simpleHTTPRequest(url) {
    config.smartLog('scraper', `Trying simple HTTP request for ${url}`);
    try {
      const response = await axios.get(url, {
        headers: this.defaultHeaders,
        timeout: 15000
      });
      
      const html = response.data;
      const $ = cheerio.load(html);
      
      let detectedPlatform = this.detectJobPlatformFromContent(html, url);
      
      if (!detectedPlatform) {
        $('script').each((i, script) => {
          const scriptContent = $(script).html() || '';
          const scriptSrc = $(script).attr('src') || '';
          
          for (const platform of this.knownJobPlatforms) {
            if (platform.patterns.some(pattern => 
              scriptContent.includes(pattern) || scriptSrc.includes(pattern)
            )) {
              detectedPlatform = platform;
              return false;
            }
          }
        });
      }
      
      if (!detectedPlatform) {
        $('iframe').each((i, iframe) => {
          const iframeSrc = $(iframe).attr('src') || '';
          
          for (const platform of this.knownJobPlatforms) {
            if (platform.patterns.some(pattern => iframeSrc.includes(pattern))) {
              detectedPlatform = platform;
              return false;
            }
          }
        });
      }
      
      const scriptCount = $('script').length;
      const iframeCount = $('iframe').length;
      const totalTextLength = $('body').text().trim().length;
      
      const dynamicContentIndicators = dictionaries.dynamicContentIndicators;
      const hasDynamicIndicators = dynamicContentIndicators.some(selector => {
        try {
          return $(selector).length > 0;
        } catch (e) {
          return false;
        }
      });
      
      const suspectJS = (
        detectedPlatform !== null ||
        hasDynamicIndicators ||
        (scriptCount > 10 && totalTextLength < 1000) || 
        (iframeCount > 0 && totalTextLength < 1000) ||
        $('body').text().includes('JavaScript is required') ||
        $('body').text().includes('Please enable JavaScript')
      );
      
      const extracted = extractContentFromCheerio($, url);
      
      if (detectedPlatform) {
        config.smartLog('platform', `Detected ${detectedPlatform.name} integration during simple HTTP request`);
      }
      
      return {
        url,
        title: extracted.title,
        text: extracted.text,
        links: extracted.links,
        scrapedAt: new Date().toISOString(),
        method: 'simple-http',
        suspectJS,
        detectedPlatform: detectedPlatform ? detectedPlatform.name : null
      };
    } catch (error) {
      config.smartLog('fail', `Error in simple HTTP request: ${error.message}`);
      return null;
    }
  }
  
  async lightweightVersions(url, suspectJS = false) {
    config.smartLog('scraper', `Trying lightweight versions for ${url}`);
    
    if (!suspectJS && Math.random() > 0.3) {
      config.smartLog('scraper', 'Page does not seem JS-heavy, skipping lightweight versions');
      return null;
    }
    
    const urlObj = new URL(url);
    const variants = [
      { 
        url, 
        headers: { 
          ...this.defaultHeaders,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
        }
      },
      { url: `${urlObj.origin}${urlObj.pathname}?amp=1` },
      { url: `${urlObj.origin}${urlObj.pathname}/amp` },
      { url: `${urlObj.origin}/amp${urlObj.pathname}` },
      { url: `${urlObj.origin}${urlObj.pathname}?print=1` },
      { url: `${urlObj.origin}${urlObj.pathname}/print` },
      { url: `${urlObj.origin}/rss` },
      { url: `${urlObj.origin}/feed` },
      { url: `${urlObj.origin}/atom` }
    ];
    
    for (const variant of variants) {
      try {
        config.smartLog('scraper', `Trying variant: ${variant.url}`);
        const response = await axios.get(variant.url, {
          headers: variant.headers || this.defaultHeaders,
          timeout: 10000
        });
        
        const html = response.data;
        const $ = cheerio.load(html);
        
        let noscriptContent = '';
        $('noscript').each((i, el) => {
          noscriptContent += $(el).text() + ' ';
        });
        
        const extracted = extractContentFromCheerio($, variant.url);
        extracted.text += ' ' + noscriptContent;
        
        if (extracted.text.length > 500 && extracted.links.length > 3) {
          return {
            url: variant.url,
            originalUrl: url,
            title: extracted.title,
            text: extracted.text,
            links: extracted.links,
            scrapedAt: new Date().toISOString(),
            method: 'lightweight-variant'
          };
        }
      } catch (error) {
        config.smartLog('scraper', `Variant failed: ${variant.url} - ${error.message}`);
      }
    }
    
    return null;
  }
  
  async headlessRendering(url, options = {}) {
    config.smartLog('scraper', `Using headless rendering for ${url}`);
    
    try {
      await this.initialize();
      
      const context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true
      });
      
      if (!options.specialPlatform) {
        await context.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot}', route => {
          route.abort();
        });
      }
      
      const page = await context.newPage();
      let result = null;
      
      try {
        let navigationSuccess = false;
        
        try {
          config.smartLog('scraper', `Navigating to ${url} with domcontentloaded strategy`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navigationSuccess = true;
        } catch (error) {
          config.smartLog('scraper', `domcontentloaded navigation failed: ${error.message}`);
        }
        
        if (!navigationSuccess) {
          try {
            config.smartLog('scraper', `Retrying with networkidle strategy`);
            await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
            navigationSuccess = true;
          } catch (error) {
            config.smartLog('scraper', `networkidle navigation failed: ${error.message}`);
            
            try {
              config.smartLog('scraper', `Final attempt with load strategy`);
              await page.goto(url, { waitUntil: 'load', timeout: 60000 });
              navigationSuccess = true;
            } catch (error) {
              config.smartLog('scraper', `All navigation strategies failed, proceeding anyway`);
            }
          }
        }
        
        await randomDelay(2000, 5000);
        
        await this.acceptCookiesIfPresent(page);
        await this.handleDynamicContent(page);
        
        const html = await page.content();
        const $ = cheerio.load(html);
        const extracted = extractContentFromCheerio($, url);
        
        result = {
          url,
          title: extracted.title,
          text: extracted.text,
          links: extracted.links,
          scrapedAt: new Date().toISOString(),
          method: 'headless-rendering'
        };
        
        if (config.DEBUG) {
          const screenshot = await page.screenshot({ fullPage: true });
          const debugFilename = `debug-${new URL(url).hostname}-${Date.now()}.png`;
          await fs.writeFile(path.join(config.DEBUG_DIR, debugFilename), screenshot);
          
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `debug-${new URL(url).hostname}-${Date.now()}.html`), 
            html
          );
        }
      } catch (error) {
        config.smartLog('fail', `Error in headless rendering: ${error.message}`);
      } finally {
        await page.close();
        await context.close();
      }
      
      return result;
    } catch (error) {
      config.smartLog('fail', `Error initializing headless browser: ${error.message}`);
      return null;
    }
  }
  
  async iframeAwareRendering(url, options = {}) {
    config.smartLog('scraper', `Using iframe-aware rendering for ${url}`);
    
    try {
      await this.initialize();
      
      const context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        permissions: ['geolocation', 'notifications'],
        bypassCSP: true
      });
      
      await context.route('**/*.{png,jpg,jpeg,gif,svg,webp}', route => {
        route.abort();
      });
      
      const page = await context.newPage();
      let result = null;
      
      try {
        config.smartLog('scraper', `Navigating to ${url} with networkidle strategy`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        
        await randomDelay(5000, 8000);
        await this.acceptCookiesIfPresent(page);
        
        const mainFrameContent = await page.content();
        const $ = cheerio.load(mainFrameContent);
        
        const jobPlatformIframes = [];
        const frames = page.frames();
        
        config.smartLog('scraper', `Found ${frames.length} frames on the page`);
        
        for (const frame of frames) {
          if (frame === page.mainFrame()) continue;
          
          const frameUrl = frame.url();
          if (!frameUrl || frameUrl === 'about:blank') continue;
          
          config.smartLog('scraper', `Examining frame: ${frameUrl}`);
          
          let isPlatformFrame = false;
          let platformName = null;
          
          for (const platform of this.knownJobPlatforms) {
            if (platform.patterns.some(pattern => frameUrl.includes(pattern))) {
              isPlatformFrame = true;
              platformName = platform.name;
              break;
            }
          }
          
          if (isPlatformFrame) {
            config.smartLog('platform', `Found ${platformName} frame: ${frameUrl}`);
            jobPlatformIframes.push({
              frame,
              url: frameUrl,
              platform: platformName
            });
          }
        }
        
        let aggregatedText = '';
        let aggregatedLinks = [];
        
        if (jobPlatformIframes.length > 0) {
          config.smartLog('scraper', `Processing ${jobPlatformIframes.length} job platform iframes`);
          
          for (const iframeInfo of jobPlatformIframes) {
            try {
              config.smartLog('platform', `Processing ${iframeInfo.platform} iframe: ${iframeInfo.url}`);
              
              const frame = iframeInfo.frame;
              
              await this.scrollInsideFrame(frame);
              await this.clickShowMoreButtonsInFrame(frame);
              
              const frameContent = await frame.content();
              const frameCheerio = cheerio.load(frameContent);
              
              const frameText = frameCheerio('body')
                .clone()
                .find('script, style, noscript, svg')
                .remove()
                .end()
                .text()
                .replace(/\s+/g, ' ')
                .trim();
              
              const frameLinks = [];
              frameCheerio('a').each((i, el) => {
                const href = frameCheerio(el).attr('href');
                const text = frameCheerio(el).text().trim();
                
                if (href && text.length > 0) {
                  let fullUrl = href;
                  
                  if (href.startsWith('/')) {
                    try {
                      const frameUrlObj = new URL(iframeInfo.url);
                      fullUrl = `${frameUrlObj.protocol}//${frameUrlObj.host}${href}`;
                    } catch (e) {
                      return;
                    }
                  } else if (!href.startsWith('http')) {
                    if (href.startsWith('#') || href.startsWith('javascript:')) {
                      return;
                    }
                    try {
                      fullUrl = new URL(href, iframeInfo.url).href;
                    } catch (e) {
                      return;
                    }
                  }
                  
                  frameLinks.push({
                    url: fullUrl,
                    text: text.replace(/\s+/g, ' ').trim(),
                    isJobPosting: true
                  });
                }
              });
              
              config.smartLog('scraper', `Extracted from iframe: ${frameText.length} chars, ${frameLinks.length} links`);
              
              aggregatedText += ' ' + frameText;
              aggregatedLinks = [...aggregatedLinks, ...frameLinks];
              
            } catch (frameError) {
              config.smartLog('fail', `Error processing iframe ${iframeInfo.url}: ${frameError.message}`);
            }
          }
        }
        
        const extracted = extractContentFromCheerio($, url);
        
        const combinedText = extracted.text + ' ' + aggregatedText;
        
        const combinedLinks = [...extracted.links, ...aggregatedLinks];
        const uniqueLinks = [];
        const seenUrls = new Set();
        
        for (const link of combinedLinks) {
          if (!seenUrls.has(link.url)) {
            seenUrls.add(link.url);
            uniqueLinks.push(link);
          }
        }
        
        result = {
          url,
          title: extracted.title,
          text: combinedText,
          links: uniqueLinks,
          scrapedAt: new Date().toISOString(),
          method: 'iframe-aware-rendering',
          processedIframes: jobPlatformIframes.length
        };
        
        if (config.DEBUG) {
          const screenshot = await page.screenshot({ fullPage: true });
          const debugFilename = `debug-${new URL(url).hostname}-${Date.now()}.png`;
          await fs.writeFile(path.join(config.DEBUG_DIR, debugFilename), screenshot);
          
          const html = await page.content();
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `debug-${new URL(url).hostname}-${Date.now()}.html`), 
            html
          );
        }
      } catch (error) {
        config.smartLog('fail', `Error in iframe-aware rendering: ${error.message}`);
      } finally {
        await page.close();
        await context.close();
      }
      
      return result;
    } catch (error) {
      config.smartLog('fail', `Error initializing browser for iframe rendering: ${error.message}`);
      return null;
    }
  }
  
  async acceptCookiesIfPresent(page) {
    config.smartLog('scraper', 'Looking for cookie banners...');
    
    const cookieSelectors = dictionaries.cookieSelectors;
    
    for (const selector of cookieSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isVisible();
          if (isVisible) {
            config.smartLog('scraper', `Found cookie banner: ${selector}`);
            await button.click().catch(() => config.smartLog('scraper', 'Failed to click cookie button'));
            await randomDelay(1000, 2000);
            return;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    config.smartLog('scraper', 'No cookie banners found or already accepted');
  }
  
  async handleDynamicContent(page) {
    await this.scrollPage(page);
    await this.clickShowMoreButtons(page);
    await this.handlePagination(page);
  }
  
  async scrollPage(page) {
    config.smartLog('scraper', 'Scrolling page to load lazy content');
    
    try {
      await page.evaluate(() => {
        return new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 300;
          let timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            
            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        });
      });
      
      await randomDelay(1000, 2000);
    } catch (error) {
      config.smartLog('fail', `Error while scrolling: ${error.message}`);
    }
  }
  
  async scrollInsideFrame(frame) {
    config.smartLog('scraper', 'Scrolling inside frame to load content');
    
    try {
      await frame.evaluate(() => {
        return new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 300;
          let timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            
            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        });
      });
      
      await randomDelay(1000, 2000);
    } catch (error) {
      config.smartLog('fail', `Error while scrolling inside frame: ${error.message}`);
    }
  }
  
  async clickShowMoreButtons(page) {
    config.smartLog('scraper', 'Looking for show more buttons');
    
    const showMoreSelectors = dictionaries.showMoreSelectors;
    const maxClicks = 5;
    let clickCount = 0;
    
    try {
      for (const selector of showMoreSelectors) {
        if (clickCount >= maxClicks) break;
        
        const buttons = await page.$$(selector).catch(() => []);
        for (const button of buttons) {
          if (clickCount >= maxClicks) break;
          
          try {
            const isVisible = await button.isVisible();
            if (!isVisible) continue;
            
            const buttonText = await button.textContent().catch(() => '');
            
            const isPositiveButton = this.isPositiveButton(buttonText);
            if (!isPositiveButton) continue;
            
            config.smartLog('scraper', `Clicking show more button: "${buttonText}"`);
            
            try {
              await button.click();
              clickCount++;
              await randomDelay(2000, 3000);
              await this.scrollPage(page);
            } catch (clickError) {
              config.smartLog('scraper', `Failed to click button: ${clickError.message}`);
              
              try {
                await page.evaluate(el => {
                  el.click();
                }, button);
                
                clickCount++;
                await randomDelay(2000, 3000);
                await this.scrollPage(page);
              } catch (jsClickError) {
                config.smartLog('scraper', `JS click also failed: ${jsClickError.message}`);
              }
            }
          } catch (buttonError) {
            continue;
          }
        }
      }
    } catch (error) {
      config.smartLog('fail', `Error while clicking show more: ${error.message}`);
    }
    
    config.smartLog('scraper', `Clicked ${clickCount} show more buttons`);
  }
  
  async clickShowMoreButtonsInFrame(frame) {
    config.smartLog('scraper', 'Looking for show more buttons in frame');
    
    const showMoreSelectors = dictionaries.showMoreSelectors;
    const maxClicks = 5;
    let clickCount = 0;
    
    try {
      for (const selector of showMoreSelectors) {
        if (clickCount >= maxClicks) break;
        
        const buttons = await frame.$$(selector).catch(() => []);
        for (const button of buttons) {
          if (clickCount >= maxClicks) break;
          
          try {
            const isVisible = await button.isVisible();
            if (!isVisible) continue;
            
            const buttonText = await button.textContent().catch(() => '');
            
            const isPositiveButton = this.isPositiveButton(buttonText);
            if (!isPositiveButton) continue;
            
            config.smartLog('scraper', `Clicking show more button in frame: "${buttonText}"`);
            
            try {
              await button.click();
              clickCount++;
              await randomDelay(2000, 3000);
              await this.scrollInsideFrame(frame);
            } catch (clickError) {
              config.smartLog('scraper', `Failed to click button in frame: ${clickError.message}`);
              
              try {
                await frame.evaluate(el => {
                  el.click();
                }, button);
                
                clickCount++;
                await randomDelay(2000, 3000);
                await this.scrollInsideFrame(frame);
              } catch (jsClickError) {
                config.smartLog('scraper', `JS click also failed in frame: ${jsClickError.message}`);
              }
            }
          } catch (buttonError) {
            continue;
          }
        }
      }
    } catch (error) {
      config.smartLog('fail', `Error while clicking show more in frame: ${error.message}`);
    }
    
    config.smartLog('scraper', `Clicked ${clickCount} show more buttons in frame`);
  }
  
  async handlePagination(page) {
    config.smartLog('scraper', 'Checking for pagination');
    
    const paginationSelectors = dictionaries.paginationSelectors;
    
    try {
      for (const selector of paginationSelectors) {
        const nextLinks = await page.$$(selector).catch(() => []);
        for (const link of nextLinks) {
          try {
            const isVisible = await link.isVisible();
            if (!isVisible) continue;
            
            const text = await link.textContent().catch(() => '');
            
            if (this.isPaginationButton(text)) {
              config.smartLog('scraper', `Clicking pagination: ${text}`);
              try {
                await link.click();
                await page.waitForTimeout(3000);
                await this.scrollPage(page);
                await this.clickShowMoreButtons(page);
                return;
              } catch (clickError) {
                config.smartLog('scraper', `Failed to click pagination: ${clickError.message}`);
                
                try {
                  await page.evaluate(el => {
                    el.click();
                  }, link);
                  
                  await page.waitForTimeout(3000);
                  await this.scrollPage(page);
                  await this.clickShowMoreButtons(page);
                  return;
                } catch (jsClickError) {
                  config.smartLog('scraper', `JS pagination click also failed: ${jsClickError.message}`);
                }
              }
            }
          } catch (linkError) {
            continue;
          }
        }
      }
    } catch (error) {
      config.smartLog('fail', `Error handling pagination: ${error.message}`);
    }
  }
  
  isPositiveButton(buttonText) {
    if (!buttonText) return false;
    
    const text = buttonText.toLowerCase().trim();
    const buttonPatterns = dictionaries.buttonPatterns;
    
    for (const [lang, patterns] of Object.entries(buttonPatterns.positive)) {
      if (lang === 'generic') continue;
      if (patterns.test(text)) {
        return true;
      }
    }
    
    if (buttonPatterns.positive.generic.test(text)) {
      return true;
    }
    
    for (const [lang, patterns] of Object.entries(buttonPatterns.negative)) {
      if (patterns.test(text)) {
        return false;
      }
    }
    
    const showMorePatterns = dictionaries.showMorePatterns;
    return showMorePatterns.regex.test(text);
  }
  
  isPaginationButton(buttonText) {
    if (!buttonText) return false;
    
    const text = buttonText.toLowerCase().trim();
    const paginationPatterns = dictionaries.paginationPatterns;
    
    for (const [lang, terms] of Object.entries(paginationPatterns.text)) {
      if (terms.some(term => text.includes(term.toLowerCase()))) {
        return true;
      }
    }
    
    if (paginationPatterns.symbols.some(symbol => text.includes(symbol))) {
      return true;
    }
    
    return paginationPatterns.regex.test(text);
  }
  
  isResultValid(result, stage) {
    if (!result) return false;
    
    const minTextLength = {
      'simple': 500,
      'light': 300,
      'headless': 200,
      'iframe': 100
    };
    
    const minLinkCount = {
      'simple': 5,
      'light': 3,
      'headless': 2,
      'iframe': 1
    };
    
    const hasEnoughText = result.text && result.text.length >= minTextLength[stage];
    const hasEnoughLinks = result.links && result.links.length >= minLinkCount[stage];
    
    if (stage === 'iframe') {
      const jobLinks = result.links.filter(link => link.isJobPosting === true);
      if (jobLinks.length >= 3) {
        config.smartLog('scraper', `Result has ${jobLinks.length} job posting links, considering valid`);
        return true;
      }
    }
    
    if (stage === 'simple' && result.suspectJS) {
      config.smartLog('scraper', 'Page seems heavily dependent on JavaScript, moving to next method');
      return false;
    }
    
    if ((stage === 'simple' || stage === 'light') && result.detectedPlatform) {
      config.smartLog('platform', `Job platform ${result.detectedPlatform} detected, preferring advanced methods`);
      return false;
    }
    
    const isValid = hasEnoughText && hasEnoughLinks;
    config.smartLog('scraper', `Result validation (${stage}): text=${result?.text?.length || 0}, links=${result?.links?.length || 0}, valid=${isValid}`);
    
    return isValid;
  }
}

module.exports = ProgressiveScraper;