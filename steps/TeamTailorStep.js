const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const cheerio = require('cheerio');

class TeamTailorStep extends BaseScraperStep {
  constructor() {
    super('teamtailor-step', 9);
  }

  async isApplicable(url, prevStepResult = {}) {
    const urlLower = url.toLowerCase();
    const isTeamTailorDomain = urlLower.includes('teamtailor.com');
    
    if (prevStepResult.detectedPlatform === 'TeamTailor') {
      console.log(`[TeamTailorStep] Applicable: Platform detected as TeamTailor`);
      return true;
    }
    
    if (isTeamTailorDomain) {
      console.log(`[TeamTailorStep] Applicable: TeamTailor domain detected in URL`);
      return true;
    }
    
    if (prevStepResult.html) {
      const platform = this.detectJobPlatform(url, prevStepResult.html);
      if (platform && platform.name === 'TeamTailor') {
        console.log(`[TeamTailorStep] Applicable: TeamTailor indicators found in HTML`);
        return true;
      }
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    console.log(`[TeamTailorStep] Starting TeamTailor scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    try {
      const startTime = Date.now();
      
      const result = await this.tryApiVariants(url, options);
      if (result) {
        result.method = 'teamtailor-api';
        result.executionTime = Date.now() - startTime;
        console.log(`[TeamTailorStep] Success with API method in ${result.executionTime}ms`);
        return result;
      }
      
      const directResult = await this.tryDirectScraping(url, options);
      if (directResult) {
        directResult.method = 'teamtailor-direct';
        directResult.executionTime = Date.now() - startTime;
        console.log(`[TeamTailorStep] Success with direct method in ${directResult.executionTime}ms`);
        return directResult;
      }
      
      console.log(`[TeamTailorStep] All methods failed for ${url}`);
      return null;

    } catch (error) {
      console.error(`[TeamTailorStep] Error scraping ${url}:`, error.message);
      return null;
    }
  }

  async tryApiVariants(url, options) {
    const companySlug = this.extractCompanySlug(url);
    if (!companySlug) return null;

    const apiEndpoints = [
      `https://${companySlug}.teamtailor.com/api/v1/jobs`,
      `https://${companySlug}.teamtailor.com/api/public/jobs`,
      `https://${companySlug}.teamtailor.com/jobs.json`,
      `${url}/api/v1/jobs`,
      `${url.replace('/jobs/', '/api/v1/jobs')}`,
      `${url}?format=json`
    ];

    for (const apiUrl of apiEndpoints) {
      try {
        console.log(`[TeamTailorStep] Trying API endpoint: ${apiUrl}`);
        
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

          if (jsonData && (Array.isArray(jsonData) || jsonData.data || jsonData.jobs)) {
            const result = this.processApiData(jsonData, url, companySlug);
            if (result) {
              result.variantType = 'teamtailor-api';
              return result;
            }
          }
        }
      } catch (error) {
        console.log(`[TeamTailorStep] API endpoint ${apiUrl} failed:`, error.message);
        continue;
      }
    }

    return null;
  }

  async tryDirectScraping(url, options) {
    try {
      console.log(`[TeamTailorStep] Trying direct scraping for ${url}`);
      
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
        const links = this.extractJobLinksFromHTML(response.data, url);
        const jobTermsFound = this.countJobTerms(text);
        
        if (links.length > 0 || jobTermsFound > 5 || this.hasJobTerms(text)) {
          const result = {
            url: url,
            title: this.extractTitle(response.data),
            text: text,
            links: links,
            scrapedAt: new Date().toISOString(),
            detectedPlatform: 'TeamTailor',
            variantType: 'teamtailor-direct',
            jobTermsFound: jobTermsFound,
            isEmpty: false
          };
          
          console.log(`[TeamTailorStep] Direct scraping successful: ${links.length} links, ${jobTermsFound} job terms`);
          return result;
        } else {
          console.log(`[TeamTailorStep] Not enough content: ${links.length} links, ${jobTermsFound} job terms`);
        }
      }
    } catch (error) {
      console.log(`[TeamTailorStep] Direct scraping failed:`, error.message);
    }

    return null;
  }

  extractJobLinksFromHTML(html, baseUrl) {
    const links = [];
    const $ = cheerio.load(html);
    
    $('a[href*="/jobs/"]').each((i, element) => {
      const href = $(element).attr('href');
      const linkText = $(element).text().trim();
      
      if (href && linkText && linkText.length > 2) {
        try {
          const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
          
          if (fullUrl.includes('teamtailor.com/jobs/') && !fullUrl.includes('#')) {
            links.push({
              url: fullUrl,
              text: linkText
            });
          }
        } catch (e) {
          console.log(`[TeamTailorStep] Invalid URL: ${href}`);
        }
      }
    });
    
    if (links.length === 0) {
      const fallbackLinks = this.extractFromJobListText(html, baseUrl);
      links.push(...fallbackLinks);
    }
    
    return links;
  }

  extractFromJobListText(html, baseUrl) {
    const links = [];
    const $ = cheerio.load(html);
    
    const jobRegex = /(\d+)\s+jobs?\s+(.*?)(?=\d+\s+jobs?|$)/gi;
    const fullText = $.text();
    
    const linkRegex = /href="([^"]*\/jobs\/[^"]+)"/gi;
    const urlsInHtml = [];
    let urlMatch;
    
    while ((urlMatch = linkRegex.exec(html)) !== null) {
      const url = urlMatch[1];
      if (url.includes('/jobs/') && !url.includes('#')) {
        try {
          const fullUrl = url.startsWith('http') ? url : new URL(url, baseUrl).href;
          urlsInHtml.push(fullUrl);
        } catch {}
      }
    }
    
    const jobTitles = this.extractJobTitlesFromText(fullText);
    
    for (let i = 0; i < Math.min(jobTitles.length, urlsInHtml.length); i++) {
      links.push({
        url: urlsInHtml[i],
        text: jobTitles[i]
      });
    }
    
    if (links.length === 0 && urlsInHtml.length > 0) {
      urlsInHtml.forEach((url, index) => {
        const jobId = url.match(/\/jobs\/(\d+)/);
        const defaultTitle = jobId ? `Job ${jobId[1]}` : `Position ${index + 1}`;
        
        links.push({
          url: url,
          text: defaultTitle
        });
      });
    }
    
    return links;
  }

  extractJobTitlesFromText(text) {
    const titles = [];
    const lines = text.split('\n');
    const jobTerms = this.getJobTerms();
    
    const patterns = [
      /^([A-Z][a-zA-Z\s&-]{5,50})\s+(?:VFX|IT|HR|Admin|Finance|Sales|Marketing|Pipeline|Animation|Commercial|Production)/i,
      /^(Senior\s+[A-Za-z\s]+?)(?:\s+VFX|\s+IT|\s+·|$)/i,
      /^(Lead\s+[A-Za-z\s]+?)(?:\s+VFX|\s+IT|\s+·|$)/i,
      /^([A-Z][a-zA-Z\s&()-]{10,60})\s+(?:·|VFX|IT|HR)/i,
      /^(Digital\s+[A-Za-z\s()]+Artist?)(?:\s+VFX|\s+·|$)/i,
      /^(Resource\s+Manager[A-Za-z\s&]+?)(?:\s+HR|\s+·|$)/i,
      /^(VFX\s+Supervisor?)(?:\s+VFX|\s+·|$)/i,
      /^(General\s+Application?)(?:\s+·|$)/i,
      /^(Internship?)(?:\s+VFX|\s+·|$)/i
    ];
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.length > 5 && trimmed.length < 80) {
        for (const pattern of patterns) {
          const match = trimmed.match(pattern);
          if (match) {
            let title = match[1].trim();
            
            title = title.replace(/\s+/g, ' ');
            
            if (title.length > 3 && !titles.includes(title)) {
              titles.push(title);
              break;
            }
          }
        }
        
        if (titles.length === 0) {
          const hasJobTerm = jobTerms.some(term => 
            trimmed.toLowerCase().includes(term.toLowerCase())
          );
          
          if (hasJobTerm && trimmed.length > 8 && trimmed.length < 60) {
            const cleanTitle = trimmed.replace(/\s*·.*$/, '').replace(/\s*VFX.*$/, '').trim();
            if (cleanTitle.length > 3 && !titles.includes(cleanTitle)) {
              titles.push(cleanTitle);
            }
          }
        }
      }
    }
    
    return titles;
  }

  processApiData(data, originalUrl, companySlug) {
    try {
      const jobs = [];
      const links = [];
      let allText = '';
      
      const jobsArray = Array.isArray(data) ? data : (data.data || data.jobs || []);
      
      for (const job of jobsArray) {
        if (job.id && (job.title || job.name)) {
          const jobTitle = job.title || job.name;
          const jobUrl = job.url || job.links?.show || `${originalUrl}/${job.id}`;
          
          links.push({
            url: jobUrl,
            text: jobTitle
          });
          
          allText += `${jobTitle} `;
          if (job.location) allText += `${job.location.name || job.location} `;
          if (job.department) allText += `${job.department.name || job.department} `;
          if (job.excerpt) allText += `${job.excerpt} `;
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
          detectedPlatform: 'TeamTailor',
          jobTermsFound: this.countJobTerms(allText),
          isEmpty: false
        };
      }
    } catch (error) {
      console.error(`[TeamTailorStep] Error processing API data:`, error.message);
    }

    return null;
  }

  extractCompanySlug(url) {
    try {
      const urlObj = new URL(url);
      
      if (urlObj.hostname.includes('teamtailor.com')) {
        const parts = urlObj.hostname.split('.');
        if (parts.length >= 3 && parts[1] === 'teamtailor') {
          return parts[0];
        }
      }
      
      const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
      if (pathParts.length > 0) {
        return pathParts[0];
      }
    } catch (error) {
      console.error(`[TeamTailorStep] Error extracting company slug:`, error.message);
    }
    return null;
  }

  extractCompanyName(slug) {
    return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'TeamTailor Company';
  }

  extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : 'TeamTailor Career Page';
  }

  cleanText(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  getStepMetadata() {
    return {
      name: this.name,
      description: 'Specialized scraper for TeamTailor job boards with API support',
      priority: this.priority,
      platforms: ['TeamTailor'],
      methods: ['teamtailor-api', 'teamtailor-direct'],
      apiEndpoints: ['/api/v1/jobs', '/api/public/jobs', '/jobs.json'],
      features: [
        'API-first approach',
        'Company slug detection',
        'Multi-endpoint fallback',
        'JSON data processing',
        'Direct HTML fallback'
      ]
    };
  }
}

module.exports = TeamTailorStep;