const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const config = require('../../config');
const path = require('path');
const fs = require('fs').promises;

class SmartRecruitersStep extends BaseScraperStep {
  constructor() {
    super('smartrecruiters-step', 6);
    this.platformConfig = null;
  }

  async isApplicable(url, context = {}) {
    const urlLower = url.toLowerCase();
    
    if (context.detectedPlatform === 'Smartrecruiters' || context.detectedPlatform === 'SmartRecruiters') {
      config.smartLog('platform', `Applicable: Platform detected as SmartRecruiters`);
      return true;
    }
    
    const dict = context.dictionary || this.getDictionary();
    const knownJobPlatforms = dict.knownJobPlatforms;
    const smartrecruitersConfig = knownJobPlatforms.find(platform => 
      platform.name.toLowerCase() === 'smartrecruiters'
    );
    
    if (smartrecruitersConfig) {
      const isSmartRecruitersDomain = smartrecruitersConfig.patterns?.some(pattern => 
        urlLower.includes(pattern.toLowerCase())
      );
      
      if (isSmartRecruitersDomain) {
        config.smartLog('platform', `Applicable: SmartRecruiters domain detected in URL`);
        return true;
      }
    }
    
    if (context.htmlContent) {
      const hasSmartRecruitersIndicators = this.detectSmartRecruitersInContent(context.htmlContent, dict);
      if (hasSmartRecruitersIndicators) {
        config.smartLog('platform', `Applicable: SmartRecruiters indicators found in HTML`);
        return true;
      }
    }
    
    return false;
  }

  detectSmartRecruitersInContent(html, dict) {
    const knownJobPlatforms = dict.knownJobPlatforms;
    const smartrecruitersConfig = knownJobPlatforms.find(platform => 
      platform.name.toLowerCase() === 'smartrecruiters'
    );
    
    if (!smartrecruitersConfig?.indicators) {
      return false;
    }
    
    const lowerHtml = html.toLowerCase();
    return smartrecruitersConfig.indicators.some(indicator => 
      lowerHtml.includes(indicator.toLowerCase())
    );
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting SmartRecruiters scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);

    let result = null;
    let scrapingError = null;
    
    try {
      const startTime = Date.now();
      
      const apiResult = await this.trySmartRecruitersApiVariants(url, options, dict);
      if (apiResult) {
        apiResult.method = 'smartrecruiters-api';
        apiResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with API method in ${apiResult.executionTime}ms`);
        return apiResult;
      }
      
      const directResult = await this.tryDirectScraping(url, options, dict);
      if (directResult) {
        directResult.method = 'smartrecruiters-direct';
        directResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with direct method in ${directResult.executionTime}ms`);
        return directResult;
      }
      
      const variantResult = await this.tryAlternativeVariants(url, options, dict);
      if (variantResult) {
        variantResult.method = 'smartrecruiters-variant';
        variantResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with variant method in ${variantResult.executionTime}ms`);
        return variantResult;
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
            methods_attempted: ['api', 'direct', 'variants']
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

  async trySmartRecruitersApiVariants(url, options, dict) {
    const companyIdentifier = this.extractCompanyIdentifier(url);
    if (!companyIdentifier) return null;

    const knownJobPlatforms = dict.knownJobPlatforms;
    const smartrecruitersConfig = knownJobPlatforms.find(platform => 
      platform.name.toLowerCase() === 'smartrecruiters'
    );

    const baseApiEndpoints = smartrecruitersConfig?.apiPatterns || [];
    const apiEndpoints = [
      ...baseApiEndpoints.map(pattern => `${url.split('?')[0]}${pattern}`),
      `https://api.smartrecruiters.com/v1/companies/${companyIdentifier}/postings`,
      `https://api.smartrecruiters.com/v1/postings?company=${companyIdentifier}`,
      `https://careers.smartrecruiters.com/${companyIdentifier}/api/jobs`,
      `${url}/api/jobs`,
      `${url}/feed`
    ];

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
            'Pragma': 'no-cache',
            'Origin': new URL(url).origin,
            'Referer': url
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

          if (this.isValidSmartRecruitersApiResponse(jsonData)) {
            const result = this.processSmartRecruitersApiData(jsonData, url, companyIdentifier, dict);
            if (result) {
              result.variantType = 'smartrecruiters-api';
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

  async tryDirectScraping(url, options, dict) {
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
        const links = this.extractJobLinksFromHtml(response.data, url, dict);
        const jobTermsFound = this.countJobTerms(text, dict);
        
        if (links.length > 0 || jobTermsFound > 3 || text.includes('Apply') || text.includes('Job')) {
          const result = {
            url: url,
            title: this.extractTitle(response.data),
            text: text,
            links: links.length > 0 ? links : this.createFallbackLinks(text, url, dict),
            scrapedAt: new Date().toISOString(),
            detectedPlatform: 'Smartrecruiters',
            variantType: 'smartrecruiters-direct',
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

  async tryAlternativeVariants(url, options, dict) {
    const variants = [
      url.replace(/\/$/, '') + '?print=1',
      url.replace(/\/$/, '') + '/feed',
      url.replace(/\/$/, '') + '/rss',
      url.replace(/\/$/, '') + '?format=json',
      url.replace('/jobs', '/api/jobs'),
      url.replace('/careers', '/api/careers'),
      url + '/feed',
      url + '/api'
    ];

    for (const variantUrl of variants) {
      try {
        config.smartLog('steps', `Trying variant: ${variantUrl}`);
        
        const response = await axios.get(variantUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache'
          }
        });

        if (response.data && response.data.length > 200) {
          const text = this.cleanText(response.data);
          const links = this.extractJobLinksFromHtml(response.data, variantUrl, dict);
          const jobTermsFound = this.countJobTerms(text, dict);
          
          if (links.length > 0 || jobTermsFound > 2) {
            const result = {
              url: url,
              title: this.extractTitle(response.data) || 'SmartRecruiters Jobs',
              text: text,
              links: links.length > 0 ? links : this.createFallbackLinks(text, url, dict),
              scrapedAt: new Date().toISOString(),
              detectedPlatform: 'Smartrecruiters',
              variantType: this.getVariantType(variantUrl),
              jobTermsFound: jobTermsFound,
              isEmpty: false
            };
            
            config.smartLog('win', `Variant successful: ${variantUrl}`);
            return result;
          }
        }
      } catch (error) {
        config.smartLog('retry', `Variant ${variantUrl} failed: ${error.message}`);
        continue;
      }
    }

    return null;
  }

  isValidSmartRecruitersApiResponse(data) {
    if (Array.isArray(data)) {
      return data.length > 0 && data[0].id && (data[0].name || data[0].title);
    }
    
    if (data && typeof data === 'object') {
      return (data.content && Array.isArray(data.content)) || 
             (data.postings && Array.isArray(data.postings)) ||
             (data.jobs && Array.isArray(data.jobs));
    }
    
    return false;
  }

  processSmartRecruitersApiData(data, originalUrl, companyIdentifier, dict) {
    try {
      let jobs = [];
      
      if (Array.isArray(data)) {
        jobs = data;
      } else if (data.content) {
        jobs = data.content;
      } else if (data.postings) {
        jobs = data.postings;
      } else if (data.jobs) {
        jobs = data.jobs;
      }

      const links = [];
      let allText = '';
      
      for (const job of jobs) {
        if (job.id && (job.name || job.title)) {
          const jobTitle = job.name || job.title;
          const jobUrl = this.constructJobUrl(originalUrl, job.id, companyIdentifier);
          
          links.push({
            url: jobUrl,
            text: jobTitle,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.9,
            department: job.department?.label || job.department || '',
            location: job.location?.city || job.location || '',
            jobType: job.typeOfEmployment?.label || job.type || ''
          });
          
          allText += `${jobTitle} `;
          if (job.department) allText += `${job.department.label || job.department} `;
          if (job.location) allText += `${job.location.city || job.location} `;
          if (job.typeOfEmployment) allText += `${job.typeOfEmployment.label || job.typeOfEmployment} `;
          allText += '\n';
        }
      }

      if (links.length > 0) {
        return {
          url: originalUrl,
          title: this.extractCompanyName(companyIdentifier),
          text: allText.trim(),
          links: links,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'Smartrecruiters',
          jobTermsFound: this.countJobTerms(allText, dict),
          isEmpty: false
        };
      }
    } catch (error) {
      config.smartLog('fail', `Error processing API data: ${error.message}`);
    }

    return null;
  }

  constructJobUrl(baseUrl, jobId, companyIdentifier) {
    try {
      const urlObj = new URL(baseUrl);
      
      if (urlObj.hostname.includes('smartrecruiters.com')) {
        return `${urlObj.origin}/job/${jobId}`;
      } else {
        return `${urlObj.origin}/job/${jobId}`;
      }
    } catch (error) {
      return `${baseUrl}/job/${jobId}`;
    }
  }

  extractJobLinksFromHtml(html, baseUrl, dict) {
    const links = [];
    const jobURLPatterns = dict.jobURLPatterns;
    
    const urlPatterns = [
      /href=["'](\/job\/[^"']+)["']/gi,
      /href=["']([^"']*\/job\/[^"']+)["']/gi,
      /href=["']([^"']*\/position\/[^"']+)["']/gi,
      /href=["']([^"']*\/apply\/[^"']+)["']/gi,
      /href=["']([^"']*\/careers\/[^"']+)["']/gi,
      ...jobURLPatterns.map(pattern => new RegExp(`href=["']([^"']*${pattern.source}[^"']*)["']`, 'gi'))
    ];

    const titlePattern = /<[^>]*class[^>]*(?:job|position|role|career)[^>]*>([^<]+)</gi;
    const titles = [];
    let titleMatch;
    
    while ((titleMatch = titlePattern.exec(html)) !== null) {
      const title = this.cleanText(titleMatch[1]).trim();
      if (title.length > 3 && title.length < 100) {
        titles.push(title);
      }
    }

    for (const pattern of urlPatterns) {
      let urlMatch;
      let linkIndex = 0;
      
      while ((urlMatch = pattern.exec(html)) !== null && linkIndex < titles.length) {
        let jobUrl = urlMatch[1];
        
        if (!jobUrl.startsWith('http')) {
          try {
            const baseUrlObj = new URL(baseUrl);
            jobUrl = new URL(jobUrl, baseUrlObj.origin).href;
          } catch (error) {
            config.smartLog('retry', `Invalid URL construction: ${jobUrl}`);
            continue;
          }
        }

        const title = titles[linkIndex] || `Job ${linkIndex + 1}`;
        
        links.push({
          url: jobUrl,
          text: title,
          isJobPosting: true,
          linkType: 'job_posting',
          confidence: 0.8
        });
        
        linkIndex++;
      }
    }
    
    if (links.length === 0) {
      const jobs = this.parseJobsFromText(this.cleanText(html), dict);
      return this.createFallbackLinks(jobs.map(j => j.title).join('\n'), baseUrl, dict);
    }
    
    return links;
  }

  parseJobsFromText(text, dict) {
    const jobs = [];
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (this.looksLikeJobTitle(line, dict)) {
        const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
        const locationMatch = nextLine.match(/(Location|Location:)\s*(.+)/i);
        const departmentMatch = nextLine.match(/(Department|Team|Division):\s*(.+)/i);
        
        jobs.push({
          title: line,
          location: locationMatch ? locationMatch[2] : '',
          department: departmentMatch ? departmentMatch[2] : ''
        });
      }
    }
    
    return jobs;
  }

  looksLikeJobTitle(text, dict) {
    if (!text || text.length < 3 || text.length > 100) return false;
    
    const jobTerms = dict.jobTerms;
    const lowerText = text.toLowerCase();
    
    const hasJobIndicator = jobTerms.some(term => lowerText.includes(term.toLowerCase()));
    const hasCommonWords = !/^(apply|read more|view details|location|department|salary)$/i.test(text);
    
    return hasJobIndicator && hasCommonWords;
  }

  createFallbackLinks(text, baseUrl, dict) {
    const jobs = this.parseJobsFromText(text, dict);
    
    if (jobs.length === 0) return [];
    
    return jobs.map((job, index) => ({
      url: `${baseUrl}#job-${index}`,
      text: job.title,
      isJobPosting: true,
      linkType: 'job_posting',
      confidence: 0.7,
      location: job.location,
      department: job.department
    }));
  }

  extractCompanyIdentifier(url) {
    try {
      const urlObj = new URL(url);
      
      if (urlObj.hostname.includes('smartrecruiters.com')) {
        const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
        return pathParts[0] || urlObj.hostname.split('.')[0];
      } else {
        return urlObj.hostname.split('.')[0];
      }
    } catch (error) {
      config.smartLog('fail', `Error extracting company identifier: ${error.message}`);
      return null;
    }
  }

  extractCompanyName(identifier) {
    if (!identifier) return 'SmartRecruiters Career Page';
    return identifier.charAt(0).toUpperCase() + identifier.slice(1);
  }

  extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      return titleMatch[1].trim();
    }
    
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) {
      return h1Match[1].trim();
    }
    
    return 'SmartRecruiters Career Page';
  }

  cleanText(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  getVariantType(url) {
    if (url.includes('print=1')) return 'print';
    if (url.includes('/feed')) return 'feed';
    if (url.includes('/rss')) return 'rss';
    if (url.includes('format=json')) return 'json';
    if (url.includes('/api/')) return 'api';
    return 'alternative';
  }

  countJobTerms(text, dict) {
    if (!text || typeof text !== 'string') return 0;
    
    const jobKeywords = dict.jobTerms;
    const lowerText = text.toLowerCase();
    let count = 0;
    
    for (const keyword of jobKeywords) {
      const regex = new RegExp(`\\b${keyword.toLowerCase()}\\b`, 'gi');
      const matches = lowerText.match(regex);
      if (matches) {
        count += matches.length;
      }
    }
    
    return count;
  }

  getStepMetadata() {
    return {
      name: this.name,
      description: 'Specialized scraper for SmartRecruiters job boards including Attrax-powered sites',
      priority: this.priority,
      platforms: ['Smartrecruiters', 'SmartRecruiters Attrax'],
      methods: ['smartrecruiters-api', 'smartrecruiters-direct', 'smartrecruiters-variant'],
      apiEndpoints: ['/api/v1/jobs', '/api/public/jobs', '/widget/api'],
      features: [
        'API-first approach',
        'Attrax support',
        'Multi-endpoint fallback',
        'JSON data processing',
        'Alternative variants support',
        'Direct HTML fallback',
        'Dictionary-based multilingual support'
      ]
    };
  }
}

module.exports = SmartRecruitersStep;