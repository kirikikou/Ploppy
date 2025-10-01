const EmailScraper = require('./EmailScraper');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

class EmailExplorer {
  constructor() {
    this.emailScraper = new EmailScraper();
    this.maxDepth = 3;
    this.maxPagesPerDomain = 50;
    this.visitedUrls = new Set();
    this.foundEmails = new Set();
    this.explorationPatterns = [
      '/contact', '/about', '/team', '/notre-equipe', '/equipe',
      '/about-us', '/qui-sommes-nous', '/impressum', '/legal',
      '/mentions-legales', '/privacy', '/support', '/help',
      '/sales', '/partners', '/careers', '/jobs', '/recruitment'
    ];
  }

  async exploreDomain(startUrl, options = {}) {
    config.smartLog('scraper', `Starting exploration of ${startUrl}`);
    
    const cached = await this.getCachedResults(startUrl);
    if (cached && !options.forceRefresh) {
        config.smartLog('cache', `Using cached results for ${startUrl}`);
        return cached;
    }
    
    config.smartLog('scraper', `Starting deep exploration of ${startUrl}`);
    
    this.visitedUrls = new Set();
    this.foundEmails = new Set();
    
    const results = {
        domain: new URL(startUrl).hostname,
        startUrl: startUrl,
        emails: [],
        pagesExplored: [],
        explorationDepth: options.maxDepth || this.maxDepth,
        startedAt: new Date().toISOString(),
        completedAt: null,
        stats: {
            totalPages: 0,
            contactPages: 0,
            emailsFound: 0,
            uniqueEmails: 0,
            errors: []
        }
    };
    
    try {
        const baseUrl = new URL(startUrl);
        const baseDomain = baseUrl.hostname;
        
        const queue = [{
            url: startUrl,
            depth: 0,
            type: 'homepage'
        }];
        
        while (queue.length > 0 && this.visitedUrls.size < this.maxPagesPerDomain) {
            const current = queue.shift();
            
            if (this.visitedUrls.has(current.url)) continue;
            if (current.depth > results.explorationDepth) continue;
            
            this.visitedUrls.add(current.url);
            results.stats.totalPages++;
            
            config.smartLog('scraper', `Exploring (depth ${current.depth}): ${current.url}`);
            
            try {
                const pageResult = await this.explorePage(current.url, baseDomain);
                
                results.pagesExplored.push({
                    url: current.url,
                    depth: current.depth,
                    type: current.type,
                    emailsFound: pageResult.emails.length,
                    linksFound: pageResult.links.length,
                    timestamp: new Date().toISOString()
                });
                
                pageResult.emails.forEach(email => {
                    if (!this.foundEmails.has(email)) {
                        this.foundEmails.add(email);
                        results.emails.push({
                            email: email,
                            foundOn: current.url,
                            pageType: current.type,
                            depth: current.depth
                        });
                    }
                });
                
                if (current.type === 'contact' || current.url.includes('contact')) {
                    results.stats.contactPages++;
                }
                
                if (current.depth < results.explorationDepth) {
                    for (const link of pageResult.links) {
                        if (!this.visitedUrls.has(link.url)) {
                            queue.push({
                                url: link.url,
                                depth: current.depth + 1,
                                type: link.type
                            });
                        }
                    }
                }
                
            } catch (error) {
                config.smartLog('fail', `Error exploring ${current.url}: ${error.message}`, { stackTrace: error.stack });
                results.stats.errors.push({
                    url: current.url,
                    error: error.message,
                    code: error.code || 'UNKNOWN'
                });
            }
            
            await this.delay(500);
        }
        
    } catch (error) {
        config.smartLog('fail', `Fatal error: ${error.message}`, { stackTrace: error.stack });
        results.stats.errors.push({
            url: startUrl,
            error: error.message,
            code: error.code || 'FATAL',
            fatal: true
        });
    }
    
    results.completedAt = new Date().toISOString();
    results.stats.emailsFound = results.emails.length;
    results.stats.uniqueEmails = this.foundEmails.size;
    results.emails = this.consolidateEmails(results.emails);
    
    if (results.stats.totalPages > 0 || results.stats.errors.length > 0) {
        await this.saveExplorationResults(results);
    }
    
    return results;
  }

  async getCachedResults(url) {
    try {
        const urlHash = crypto.createHash('md5').update(url).digest('hex');
        const domain = new URL(url).hostname.replace(/[^a-z0-9]/gi, '_');
        const filename = `email_exploration_${domain}_${urlHash}.json`;
        const filepath = path.join(__dirname, '../cache', filename);
        
        const stats = await fs.stat(filepath);
        const ageInHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
        
        if (ageInHours < 24 * 365) {
            const content = await fs.readFile(filepath, 'utf8');
            return JSON.parse(content);
        }
    } catch (error) {
        return null;
    }
  }

  async explorePage(url, baseDomain) {
    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive'
            },
            maxRedirects: 5,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            }
        });
        
        const html = response.data;
        const $ = cheerio.load(html);
        
        const emails = this.emailScraper.extractEmailsFromHTML(html);
        
        const links = [];
        $('a[href]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase().trim();
            
            if (!href) return;
            
            try {
                const linkUrl = new URL(href, url);
                
                if (linkUrl.hostname !== baseDomain) return;
                if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') return;
                
                const cleanUrl = linkUrl.origin + linkUrl.pathname;
                
                const isImportant = this.explorationPatterns.some(pattern => 
                    cleanUrl.toLowerCase().includes(pattern) ||
                    text.includes('contact') ||
                    text.includes('email') ||
                    text.includes('equipe') ||
                    text.includes('team')
                );
                
                if (isImportant || links.length < 20) {
                    links.push({
                        url: cleanUrl,
                        type: this.classifyPageType(cleanUrl, text)
                    });
                }
            } catch (e) {}
        });
        
        return {
            emails: emails,
            links: this.prioritizeLinks(links)
        };
        
    } catch (error) {
        config.smartLog('fail', `Error fetching ${url}: ${error.message}`, { 
            stackTrace: error.stack,
            status: error.response?.status
        });
        throw error;
    }
  }

  classifyPageType(url, text) {
    const urlLower = url.toLowerCase();
    const textLower = text.toLowerCase();
    
    if (urlLower.includes('contact') || textLower.includes('contact')) return 'contact';
    if (urlLower.includes('about') || textLower.includes('about')) return 'about';
    if (urlLower.includes('team') || textLower.includes('equipe')) return 'team';
    if (urlLower.includes('legal') || urlLower.includes('mentions')) return 'legal';
    if (urlLower.includes('career') || urlLower.includes('job')) return 'careers';
    
    return 'general';
  }

  prioritizeLinks(links) {
    const priority = {
      'contact': 1,
      'about': 2,
      'team': 3,
      'legal': 4,
      'careers': 5,
      'general': 6
    };
    
    return links
      .sort((a, b) => (priority[a.type] || 99) - (priority[b.type] || 99))
      .slice(0, 10);
  }

  consolidateEmails(emailList) {
    const emailMap = new Map();
    
    for (const item of emailList) {
      if (!emailMap.has(item.email)) {
        emailMap.set(item.email, {
          email: item.email,
          foundOn: [item.foundOn],
          pageTypes: [item.pageType],
          firstSeen: item.foundOn,
          occurrences: 1
        });
      } else {
        const existing = emailMap.get(item.email);
        existing.foundOn.push(item.foundOn);
        existing.pageTypes.push(item.pageType);
        existing.occurrences++;
      }
    }
    
    return Array.from(emailMap.values())
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  async saveExplorationResults(results) {
    const urlHash = crypto.createHash('md5').update(results.startUrl).digest('hex');
    const domain = results.domain.replace(/[^a-z0-9]/gi, '_');
    const filename = `email_exploration_${domain}_${urlHash}.json`;
    const filepath = path.join(__dirname, '../cache', filename);

    try {
      const cacheDir = path.join(__dirname, '../cache');
      await fs.mkdir(cacheDir, { recursive: true });
      
      await fs.writeFile(filepath, JSON.stringify(results, null, 2));
      config.smartLog('scraper', `Saved exploration results to ${filename}`);
    } catch (error) {
      config.smartLog('fail', `Error saving results: ${error.message}`, { stackTrace: error.stack });
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = EmailExplorer;