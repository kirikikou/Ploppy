const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const config = require('../../config');
const path = require('path');
const fs = require('fs').promises;

class LeverStep extends BaseScraperStep {
  constructor() {
    super('lever-step', 8);
  }

  async isApplicable(url, context = {}) {
    if (context.options && context.options.dictionary) {
      this.setDictionary(context.options.dictionary);
    }
    
    const urlLower = url.toLowerCase();
    const dict = this.getDictionary();
    const platforms = dict.knownJobPlatforms;
    const leverPlatform = platforms.find(p => p.name === 'Lever');
    
    if (!leverPlatform) {
      config.smartLog('platform', `Platform config not found`);
      return false;
    }
    
    const isLeverDomain = leverPlatform.patterns.some(pattern => urlLower.includes(pattern));
    
    const detectedPlatformName = typeof context.detectedPlatform === 'string' ? context.detectedPlatform : context.detectedPlatform?.name;
    const optionsDetectedPlatformName = typeof context.options?.detectedPlatform === 'string' ? context.options.detectedPlatform : context.options?.detectedPlatform?.name;
    
    if (detectedPlatformName === 'Lever' || optionsDetectedPlatformName === 'Lever') {
      config.smartLog('platform', `Applicable: Platform detected as Lever`);
      return true;
    }
    
    if (isLeverDomain) {
      config.smartLog('platform', `Applicable: Lever domain detected in URL`);
      return true;
    }
    
    const htmlContent = context.htmlContent || context.html || '';
    if (htmlContent) {
      const hasLeverIndicators = this.detectLeverInContent(htmlContent);
      if (hasLeverIndicators) {
        config.smartLog('platform', `Applicable: Lever indicators found in HTML`);
        return true;
      }
    }
    
    return false;
  }

  detectLeverInContent(html) {
    const dict = this.getDictionary();
    const platforms = dict.knownJobPlatforms;
    const leverPlatform = platforms.find(p => p.name === 'Lever');
    if (!leverPlatform || !leverPlatform.indicators) return false;
    
    const lowerHtml = html.toLowerCase();
    return leverPlatform.indicators.some(indicator => lowerHtml.includes(indicator.toLowerCase()));
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting Lever scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);

    let result = null;
    let scrapingError = null;
    
    try {
      const startTime = Date.now();
      
      const apiResult = await this.tryLeverApiVariants(url, options);
      if (apiResult) {
        apiResult.method = 'lever-api';
        apiResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with API method in ${apiResult.executionTime}ms`);
        return apiResult;
      }
      
      const directResult = await this.tryDirectScraping(url, options);
      if (directResult) {
        directResult.method = 'lever-direct';
        directResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with direct method in ${directResult.executionTime}ms`);
        return directResult;
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
            methods_attempted: ['api', 'direct']
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

  async tryLeverApiVariants(url, options) {
    const companySlug = this.extractCompanySlug(url);
    if (!companySlug) return null;

    const dict = this.getDictionary();
    const platforms = dict.knownJobPlatforms;
    const leverPlatform = platforms.find(p => p.name === 'Lever');
    const baseEndpoints = leverPlatform ? leverPlatform.apiPatterns : ['/_postings', '/v0/postings', '/v1/postings'];
    
    const apiEndpoints = baseEndpoints.map(endpoint => 
      `https://jobs.lever.co/${companySlug}${endpoint}`
    );

    for (const apiUrl of apiEndpoints) {
      try {
        config.smartLog('steps', `Trying API endpoint: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
          timeout: options.timeout || 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
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

          if (Array.isArray(jsonData) && jsonData.length > 0) {
            const result = this.processLeverApiData(jsonData, url, companySlug);
            if (result) {
              result.variantType = 'lever-api';
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

  async tryDirectScraping(url, options) {
    try {
      config.smartLog('steps', `Trying direct scraping for ${url}`);
      
      const response = await axios.get(url, {
        timeout: options.timeout || 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (response.data && response.data.length > 500) {
        const text = this.cleanText(response.data);
        const links = this.extractJobLinksFromHtml(response.data, url);
        const jobTermsFound = this.countJobTerms(text);
        
        const dict = this.getDictionary();
        const navigationTerms = dict.jobNavigationTextSelectors || [];
        const hasApplyTerms = navigationTerms.some(term => text.toLowerCase().includes(term.toLowerCase()));
        
        if (links.length > 0 || jobTermsFound > 5 || hasApplyTerms) {
          const result = {
            url: url,
            title: this.extractTitle(response.data),
            text: text,
            links: links.length > 0 ? links : this.createFallbackLinks(text, url),
            scrapedAt: new Date().toISOString(),
            detectedPlatform: 'Lever',
            variantType: 'lever-direct',
            jobTermsFound: jobTermsFound,
            isEmpty: false
          };
          
          config.smartLog('win', `Direct scraping successful: ${links.length} links, ${jobTermsFound} job terms`);
          return result;
        } else {
          config.smartLog('retry', `Not enough content: ${links.length} links, ${jobTermsFound} job terms`);
        }
      }
    } catch (error) {
      config.smartLog('retry', `Direct scraping failed: ${error.message}`);
    }

    return null;
  }

  createFallbackLinks(text, baseUrl) {
    const jobs = this.parseJobsFromLeverText(text);
    const companySlug = this.extractCompanySlug(baseUrl);
    
    if (jobs.length === 0) return [];
    
    return jobs.map((job, index) => ({
      url: `${baseUrl}#job-${index}`,
      text: job.title,
      isJobPosting: true,
      linkType: 'job_posting',
      confidence: 0.85,
      location: job.location,
      workType: job.workType,
      department: job.department
    }));
  }

  processLeverApiData(data, originalUrl, companySlug) {
    try {
      const jobs = [];
      const links = [];
      let allText = '';
      
      const dict = this.getDictionary();
      const navigationTerms = dict.jobNavigationTextSelectors || [];
      const defaultApplyText = navigationTerms.length > 0 ? navigationTerms[0] : 'Apply';
      
      for (const job of data) {
        if (job.id && job.text) {
          const jobUrl = `https://jobs.lever.co/${companySlug}/${job.id}`;
          links.push({
            url: jobUrl,
            text: job.text || defaultApplyText,
            isJobPosting: true,
            linkType: 'career_navigation',
            confidence: 0.9
          });
          
          allText += `${job.text} `;
          if (job.categories) {
            if (job.categories.location) allText += `${job.categories.location} `;
            if (job.categories.department) allText += `${job.categories.department} `;
            if (job.categories.commitment) allText += `${job.categories.commitment} `;
          }
          allText += '\n';
        }
      }

      if (links.length > 0) {
        return {
          url: originalUrl,
          title: this.extractCompanyName(companySlug),
          text: allText.trim(),
          links: links,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'Lever',
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
    const text = this.cleanText(html);
    
    const jobMatches = this.parseJobsFromLeverText(text);
    
    const leverUrlPattern = /href=["'](https:\/\/jobs\.lever\.co\/[^\/]+\/[a-f0-9-]+)["']/gi;
    const urls = [];
    let urlMatch;
    
    while ((urlMatch = leverUrlPattern.exec(html)) !== null) {
      urls.push(urlMatch[1]);
    }
    
    for (let i = 0; i < Math.min(jobMatches.length, urls.length); i++) {
      const job = jobMatches[i];
      const url = urls[i];
      
      links.push({
        url: url,
        text: job.title,
        isJobPosting: true,
        linkType: 'job_posting',
        confidence: 0.95,
        location: job.location,
        workType: job.workType,
        department: job.department
      });
    }
    
    return links;
  }

  parseJobsFromLeverText(text) {
    const jobs = [];
    const dict = this.getDictionary();
    const navigationTerms = dict.jobNavigationTextSelectors || [];
    
    const cleanedText = text
      .replace(new RegExp(`(${navigationTerms.join('|')})`, 'gi'), '\n$1 ')
      .replace(/(On-site|Hybrid|Remote)\s*[—-]\s*(Full-time|Part-time|Internship|Consultant|Intern|Alternance|Full Time - Local|Consultant - International|Consultant - Local)/g, 
               '\n$1 — $2\n')
      .replace(/(Paris|Barcelona|Lille|Brussels|Washington DC|Abuja|Addis Ababa|Bamako|Bayelsa|Beirut|Bishkek|Erbil|Chad|Niger|Burkina Faso|Sokoto)/g, '$1\n');
    
    const lines = cleanedText.split('\n').filter(line => line.trim().length > 0);
    
    for (let i = 0; i < lines.length - 2; i++) {
      const line = lines[i].trim();
      
      const hasApplyTerm = navigationTerms.some(term => line.toLowerCase().startsWith(term.toLowerCase() + ' '));
      
      if (hasApplyTerm) {
        let title = line;
        navigationTerms.forEach(term => {
          const regex = new RegExp(`^${term}\\s+`, 'gi');
          title = title.replace(regex, '');
        });
        title = title.trim();
        
        const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
        const locationLine = lines[i + 2] ? lines[i + 2].trim() : '';
        
        const workTypeMatch = nextLine.match(/(On-site|Hybrid|Remote)\s*[—-]\s*(Full-time|Part-time|Internship|Consultant|Intern|Alternance|Full Time - Local|Consultant - International|Consultant - Local)/);
        
        if (workTypeMatch && title.length > 2 && title.length < 100) {
          const cleanTitle = title
            .replace(/^(Customer Experience|Finance|General|Marketing|People|Performance & Data|Product Development|Sales|Tech)\s+/i, '')
            .replace(/\s+(French Market|Global Market|Spanish Market|Africa - West|Brussels - HQ|Washington DC - HQ|Middle East and North Africa|Africa - Central & East|Asia|Other teams)$/i, '')
            .trim();
          
          if (cleanTitle && cleanTitle.length > 2) {
            jobs.push({
              title: cleanTitle,
              workType: workTypeMatch[1],
              commitment: workTypeMatch[2],
              location: locationLine || 'Not specified',
              department: title.includes('French Market') ? 'French Market' : 
                         title.includes('Global Market') ? 'Global Market' :
                         title.includes('Spanish Market') ? 'Spanish Market' : ''
            });
          }
        }
      }
    }
    
    if (jobs.length === 0) {
      const applyPattern = new RegExp(`(${navigationTerms.join('|')})([^${navigationTerms.join('')}]+?)(?=${navigationTerms.join('|')}|$)`, 'gi');
      let match;
      
      while ((match = applyPattern.exec(text)) !== null) {
        const fullMatch = match[2].trim();
        
        const titleMatch = fullMatch.match(/^(.+?)(On-site|Hybrid|Remote)/);
        if (titleMatch) {
          let title = titleMatch[1].trim();
          
          title = title
            .replace(/^(Customer Experience|Finance|General|Marketing|People|Performance & Data|Product Development|Sales|Tech)\s+/i, '')
            .replace(/\s+(French Market|Global Market|Spanish Market)$/i, '')
            .trim();
          
          if (title && title.length > 2 && title.length < 100) {
            jobs.push({
              title: title,
              workType: titleMatch[2],
              commitment: 'Full-time',
              location: 'Not specified',
              department: ''
            });
          }
        }
      }
    }
    
    return jobs;
  }

  extractCompanySlug(url) {
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname === 'jobs.lever.co') {
        const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
        return pathParts[0] || null;
      }
    } catch (error) {
      config.smartLog('fail', `Error extracting company slug: ${error.message}`);
    }
    return null;
  }

  extractCompanyName(slug) {
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  }

  extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : 'Lever Career Page';
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
    const dict = this.getDictionary();
    const patterns = dict.jobURLPatterns;
    const lowerUrl = url.toLowerCase();
    
    return patterns.some(pattern => pattern.test(lowerUrl)) || 
           lowerUrl.includes('jobs.lever.co');
  }

  getStepMetadata() {
    const dict = this.getDictionary();
    return {
      name: this.name,
      description: 'Specialized scraper for Lever.co job boards with API support',
      priority: this.priority,
      platforms: ['Lever'],
      methods: ['lever-api', 'lever-direct'],
      apiEndpoints: ['/_postings', '/v0/postings', '/v1/postings'],
      features: [
        'API-first approach',
        'Company slug detection',
        'Multi-endpoint fallback',
        'JSON data processing',
        'Direct HTML fallback',
        'Multilingual support'
      ],
      supportedLanguages: dict.getSupportedLanguages ? dict.getSupportedLanguages() : ['en', 'fr']
    };
  }
}

module.exports = LeverStep;