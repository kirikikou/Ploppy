const { chromium } = require('playwright');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const config = require('../config');

class EmailScraper {
  constructor() {
    this.emailPatterns = [
      /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi,
      /([a-zA-Z0-9._-]+\s*\[at\]\s*[a-zA-Z0-9._-]+\s*\[dot\]\s*[a-zA-Z0-9_-]+)/gi,
      /([a-zA-Z0-9._-]+\s*\(at\)\s*[a-zA-Z0-9._-]+\s*\(dot\)\s*[a-zA-Z0-9_-]+)/gi,
      /([a-zA-Z0-9._-]+\s*@\s*[a-zA-Z0-9._-]+\s*\.\s*[a-zA-Z0-9_-]+)/gi
    ];
    
    this.contactPagePatterns = [
      '/contact', '/contactus', '/contact-us', '/about/contact',
      '/company/contact', '/get-in-touch', '/reach-us',
      '/contact.html', '/contact.php', '/kontakt', '/contacto'
    ];
    
    this.excludedEmails = [
      'example@example.com', 'test@test.com', 'demo@demo.com',
      'noreply@', 'no-reply@', 'donotreply@', 'mailer-daemon@'
    ];
  }

  normalizeEmail(email) {
    return email
      .toLowerCase()
      .replace(/\s*\[at\]\s*/gi, '@')
      .replace(/\s*\[dot\]\s*/gi, '.')
      .replace(/\s*\(at\)\s*/gi, '@')
      .replace(/\s*\(dot\)\s*/gi, '.')
      .replace(/\s+/g, '');
  }

  isValidEmail(email) {
    const normalized = this.normalizeEmail(email);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(normalized)) return false;
    
    for (const excluded of this.excludedEmails) {
      if (normalized.includes(excluded)) return false;
    }
    
    const [localPart, domain] = normalized.split('@');
    if (localPart.length < 2 || domain.length < 4) return false;
    
    return true;
  }

  extractEmailsFromText(text) {
    const emails = new Set();
    
    for (const pattern of this.emailPatterns) {
      const matches = text.match(pattern) || [];
      for (const match of matches) {
        const normalized = this.normalizeEmail(match);
        if (this.isValidEmail(normalized)) {
          emails.add(normalized);
        }
      }
    }
    
    return Array.from(emails);
  }

  extractEmailsFromHTML(html) {
    const $ = cheerio.load(html);
    const emails = new Set();
    
    $('a[href^="mailto:"]').each((i, el) => {
      const href = $(el).attr('href');
      const email = href.replace('mailto:', '').split('?')[0];
      if (this.isValidEmail(email)) {
        emails.add(this.normalizeEmail(email));
      }
    });
    
    const textContent = $.text();
    const textEmails = this.extractEmailsFromText(textContent);
    textEmails.forEach(email => emails.add(email));
    
    $('script').each((i, el) => {
      const scriptContent = $(el).html();
      if (scriptContent) {
        const scriptEmails = this.extractEmailsFromText(scriptContent);
        scriptEmails.forEach(email => emails.add(email));
      }
    });
    
    return Array.from(emails);
  }

  async findContactPages(baseUrl, html) {
    const $ = cheerio.load(html);
    const contactUrls = new Set();
    
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().toLowerCase();
      
      if (!href) return;
      
      const isContactLink = this.contactPagePatterns.some(pattern => 
        href.toLowerCase().includes(pattern) || 
        text.includes('contact') || 
        text.includes('kontakt') ||
        text.includes('contacto')
      );
      
      if (isContactLink) {
        try {
          const fullUrl = new URL(href, baseUrl).href;
          if (fullUrl.startsWith('http')) {
            contactUrls.add(fullUrl);
          }
        } catch (e) {}
      }
    });
    
    return Array.from(contactUrls).slice(0, 3);
  }

  async scrapePageForEmails(url, options = {}) {
    const emails = new Set();
    const scrapedUrls = new Set([url]);
    
    try {
      config.smartLog('scraper', `Scraping emails from: ${url}`);
      
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        }
      });
      
      const html = response.data;
      const pageEmails = this.extractEmailsFromHTML(html);
      pageEmails.forEach(email => emails.add(email));
      
      config.smartLog('scraper', `Found ${pageEmails.length} emails on main page`);
      
      if (options.searchContactPages !== false) {
        const contactPages = await this.findContactPages(url, html);
        config.smartLog('scraper', `Found ${contactPages.length} potential contact pages`);
        
        for (const contactUrl of contactPages) {
          if (scrapedUrls.has(contactUrl)) continue;
          scrapedUrls.add(contactUrl);
          
          try {
            const contactResponse = await axios.get(contactUrl, {
              timeout: 5000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            
            const contactEmails = this.extractEmailsFromHTML(contactResponse.data);
            contactEmails.forEach(email => emails.add(email));
            
            config.smartLog('scraper', `Found ${contactEmails.length} emails on contact page: ${contactUrl}`);
          } catch (e) {
            config.smartLog('scraper', `Failed to scrape contact page: ${contactUrl}`);
          }
        }
      }
      
    } catch (error) {
      config.smartLog('fail', `Error scraping ${url}: ${error.message}`, { stackTrace: error.stack });
    }
    
    return {
      emails: Array.from(emails),
      scrapedUrls: Array.from(scrapedUrls)
    };
  }

  async scrapeWithPlaywright(url, options = {}) {
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      await page.waitForTimeout(2000);
      
      const emails = await page.evaluate(() => {
        const foundEmails = new Set();
        
        document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
          const email = link.href.replace('mailto:', '').split('?')[0];
          foundEmails.add(email);
        });
        
        const bodyText = document.body.innerText || document.body.textContent || '';
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
        const matches = bodyText.match(emailRegex) || [];
        matches.forEach(email => foundEmails.add(email));
        
        return Array.from(foundEmails);
      });
      
      const validEmails = emails.filter(email => this.isValidEmail(email))
                                .map(email => this.normalizeEmail(email));
      
      await browser.close();
      
      return {
        emails: [...new Set(validEmails)],
        scrapedUrls: [url]
      };
      
    } catch (error) {
      if (browser) await browser.close();
      throw error;
    }
  }

  getCacheFilename(url) {
    const urlHash = crypto.createHash('md5').update(url).digest('hex');
    const domain = new URL(url).hostname.replace(/[^a-z0-9]/gi, '_');
    return path.join(__dirname, '../cache', `emails_${domain}_${urlHash}.json`);
  }

  async getCachedEmails(url) {
    try {
      const cacheFile = this.getCacheFilename(url);
      const stats = await fs.stat(cacheFile);
      const ageInHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
      
      if (ageInHours < 24 * 7) {
        const content = await fs.readFile(cacheFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {}
    
    return null;
  }

  async saveToCacheEmails(url, data) {
    try {
      const cacheFile = this.getCacheFilename(url);
      const cacheDir = path.join(__dirname, '../cache');
      await fs.mkdir(cacheDir, { recursive: true });
      
      const cacheData = {
        url: url,
        domain: new URL(url).hostname,
        emails: data.emails,
        scrapedUrls: data.scrapedUrls,
        scrapedAt: new Date().toISOString(),
        version: '1.0'
      };
      
      await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
      config.smartLog('scraper', `Saved ${data.emails.length} emails to cache for ${url}`);
      return true;
    } catch (error) {
      config.smartLog('fail', `Error saving to cache: ${error.message}`, { stackTrace: error.stack });
      return false;
    }
  }

  async scrapeEmails(url, options = {}) {
    const cached = await this.getCachedEmails(url);
    if (cached && !options.forceRefresh) {
      config.smartLog('scraper', `Using cached emails for ${url}`);
      return cached;
    }
    
    let result;
    
    try {
      result = await this.scrapePageForEmails(url, options);
      
      if (result.emails.length === 0 && options.usePlaywright) {
        config.smartLog('scraper', 'No emails found with axios, trying Playwright');
        result = await this.scrapeWithPlaywright(url, options);
      }
    } catch (error) {
      config.smartLog('fail', `Primary scraping failed, trying Playwright: ${error.message}`, { stackTrace: error.stack });
      if (options.usePlaywright !== false) {
        try {
          result = await this.scrapeWithPlaywright(url, options);
        } catch (playwrightError) {
          config.smartLog('fail', `Playwright scraping also failed: ${playwrightError.message}`, { stackTrace: playwrightError.stack });
          result = { emails: [], scrapedUrls: [url] };
        }
      } else {
        result = { emails: [], scrapedUrls: [url] };
      }
    }
    
    await this.saveToCacheEmails(url, result);
    
    return {
      url: url,
      domain: new URL(url).hostname,
      emails: result.emails,
      scrapedUrls: result.scrapedUrls,
      scrapedAt: new Date().toISOString()
    };
  }

  async scrapeMultipleUrls(urls, options = {}) {
    const results = [];
    
    for (const url of urls) {
      try {
        const result = await this.scrapeEmails(url, options);
        results.push(result);
      } catch (error) {
        config.smartLog('fail', `Failed to scrape ${url}: ${error.message}`, { stackTrace: error.stack });
        results.push({
          url: url,
          domain: new URL(url).hostname,
          emails: [],
          error: error.message,
          scrapedAt: new Date().toISOString()
        });
      }
    }
    
    return results;
  }
}

module.exports = EmailScraper;