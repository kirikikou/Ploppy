const BaseScraperStep = require('./BaseScraperStep');
const errorCaptureMiddleware = require('../../middleware/errorCaptureMiddleware');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const config = require('../../config');
const fs = require('fs').promises;
const path = require('path');

class iCIMSStep extends BaseScraperStep {
  constructor() {
    super('icims-step', 7);
    this.browser = null;
    this.platformConfig = null;
  }

  async initialize() {
    const dict = this.getDictionary();
    this.platformConfig = dict.getKnownJobPlatforms().find(p => p.name === 'iCIMS');
  }

  async execute(url, options = {}) {
    const startTime = Date.now();
    
    try {
      const result = await this.scrape(url, options);
      
      if (!result || !result.success) {
        errorCaptureMiddleware.logScrapingError({
          url,
          step: this.constructor.name,
          message: result?.error || 'Step execution unsuccessful',
          executionTime: Date.now() - startTime,
          userId: options.userId,
          userEmail: options.userEmail,
          sessionId: options.sessionId
        });
      }
      
      return result;
    } catch (error) {
      errorCaptureMiddleware.logStepFailure({
        url,
        step: this.constructor.name,
        error,
        executionTime: Date.now() - startTime,
        userId: options.userId,
        userEmail: options.userEmail,
        sessionId: options.sessionId
      });
      throw error;
    }
  }

  async detectIframeContent(url, options) {
    if (options.isIframeContent) {
      return null;
    }
    
    try {
      config.smartLog('steps', `Checking for iframe content in ${url}`);
      
      let html = options.htmlContent;
      if (!html) {
        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        html = response.data;
      }
      
      if (!this.platformConfig) {
        await this.initialize();
      }
      
      const dict = this.getDictionary();
      const patterns = dict.getPatterns();
      const iframePatterns = patterns.icimsIframePatterns || this.platformConfig?.iframePatterns || [];
      
      for (const pattern of iframePatterns) {
        const regex = new RegExp(pattern, 'gi');
        const matches = html.match(regex);
        if (matches && matches.length > 0) {
          const match = matches[0].match(/src=["']([^"']*)["']/);
          if (match && match[1]) {
            let iframeUrl = match[1].replace(/&amp;/g, '&');
            
            if (iframeUrl.startsWith('//')) {
              iframeUrl = 'https:' + iframeUrl;
            } else if (iframeUrl.startsWith('/')) {
              const baseUrl = this.extractBaseUrl(url);
              iframeUrl = baseUrl + iframeUrl;
            }
            
            config.smartLog('steps', `Found iframe URL: ${iframeUrl}`);
            return iframeUrl;
          }
        }
      }
      
      const jsPattern = patterns.icimsJsIframePattern || /icimsFrame\.src\s*=\s*['"]([^'"]*)['"]/gi;
      const jsMatch = html.match(jsPattern);
      if (jsMatch && jsMatch.length > 0) {
        const urlMatch = jsMatch[0].match(/['"]([^'"]*)['"]/);
        if (urlMatch && urlMatch[1]) {
          let iframeUrl = urlMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
          if (iframeUrl.startsWith('https:')) {
            config.smartLog('steps', `Found JS iframe URL: ${iframeUrl}`);
            return iframeUrl;
          }
        }
      }
      
    } catch (error) {
      config.smartLog('fail', `Error detecting iframe content: ${error.message}`);
    }
    
    return null;
  }

  async isApplicable(url, prevStepResult = {}) {
    if (!this.platformConfig) {
      await this.initialize();
    }
    
    const urlLower = url.toLowerCase();
    const isICIMSDomain = this.platformConfig.patterns.some(pattern => 
      urlLower.includes(pattern.toLowerCase())
    );
    
    if (prevStepResult.detectedPlatform === 'iCIMS') {
      config.smartLog('platform', `Platform detected as iCIMS`);
      return true;
    }
    
    if (isICIMSDomain) {
      config.smartLog('platform', `iCIMS domain detected in URL`);
      return true;
    }
    
    if (prevStepResult.html || prevStepResult.htmlContent) {
      const html = prevStepResult.html || prevStepResult.htmlContent;
      const hasICIMSIndicators = this.detectICIMSInContent(html);
      if (hasICIMSIndicators) {
        config.smartLog('platform', `iCIMS indicators found in HTML`);
        return true;
      }
    }
    
    return false;
  }

  detectICIMSInContent(html) {
    if (!this.platformConfig) {
      const dict = this.getDictionary();
      this.platformConfig = dict.getKnownJobPlatforms().find(p => p.name === 'iCIMS');
    }
    
    const lowerHtml = html.toLowerCase();
    return this.platformConfig.indicators.some(indicator => 
      lowerHtml.includes(indicator.toLowerCase())
    );
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting iCIMS scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    if (!this.platformConfig) {
      await this.initialize();
    }

    let result = null;
    let scrapingError = null;
    
    try {
      const startTime = Date.now();
      
      const iframeUrl = await this.detectIframeContent(url, options);
      if (iframeUrl && iframeUrl !== url) {
        config.smartLog('steps', `Detected iframe content, switching to: ${iframeUrl}`);
        return await this.scrape(iframeUrl, { ...options, isIframeContent: true });
      }
      
      const apiResult = await this.tryICIMSApiVariants(url, options);
      if (apiResult) {
        apiResult.method = 'icims-api';
        apiResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with API method in ${apiResult.executionTime}ms`);
        result = apiResult;
      }
      
      if (!result) {
        const directResult = await this.tryDirectScraping(url, options);
        if (directResult) {
          directResult.method = 'icims-direct';
          directResult.executionTime = Date.now() - startTime;
          config.smartLog('win', `Success with direct method in ${directResult.executionTime}ms`);
          result = directResult;
        }
      }
      
      if (!result) {
        const headlessResult = await this.tryHeadlessScraping(url, options);
        if (headlessResult) {
          headlessResult.method = 'icims-headless';
          headlessResult.executionTime = Date.now() - startTime;
          config.smartLog('win', `Success with headless method in ${headlessResult.executionTime}ms`);
          result = headlessResult;
        }
      }
      
      if (!result) {
        config.smartLog('fail', `All methods failed for ${url}`);
        scrapingError = new Error('All methods failed');
      }

      if (config.shouldExportDebug(result, scrapingError, this.name)) {
        await this.exportDebugInfo(url, scrapingError);
      }

    } catch (error) {
      config.smartLog('fail', `Error scraping ${url}: ${error.message}`);
      scrapingError = error;
    }
    
    return result;
  }

  async tryICIMSApiVariants(url, options) {
    const baseUrl = this.extractBaseUrl(url);
    if (!baseUrl) return null;

    const apiEndpoints = this.platformConfig.apiPatterns?.map(pattern => 
      `${baseUrl}${pattern}`
    ) || [];

    for (const apiUrl of apiEndpoints) {
      try {
        config.smartLog('steps', `Trying API endpoint: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
          timeout: options.timeout || 15000,
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': this.getAcceptLanguageHeader(),
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
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

          if (this.isValidICIMSApiResponse(jsonData)) {
            const result = this.processICIMSApiData(jsonData, url);
            if (result) {
              result.variantType = 'icims-api';
              return result;
            }
          }
        }
      } catch (error) {
        config.smartLog('fail', `API endpoint ${apiUrl} failed: ${error.message}`);
        continue;
      }
    }

    return null;
  }

  getAcceptLanguageHeader() {
    const currentLang = this.getDictionary().getCurrentLanguage();
    const dict = this.getDictionary();
    const universal = dict.getUniversalSelectors();
    const headerMap = universal.languageHeaders || {};
    return headerMap[currentLang] || 'en-US,en;q=0.9';
  }

  isValidICIMSApiResponse(data) {
    if (!data) return false;
    
    if (Array.isArray(data) && data.length > 0) {
      return data.some(item => item.jobTitle || item.title || item.positionTitle);
    }
    
    if (data.jobs && Array.isArray(data.jobs) && data.jobs.length > 0) {
      return data.jobs.some(job => job.jobTitle || job.title || job.positionTitle);
    }
    
    if (data.searchResults && Array.isArray(data.searchResults)) {
      return data.searchResults.length > 0;
    }
    
    return false;
  }

  processICIMSApiData(data, originalUrl) {
    try {
      const jobs = [];
      const links = [];
      let allText = '';
      
      let jobsArray = [];
      if (Array.isArray(data)) {
        jobsArray = data;
      } else if (data.jobs && Array.isArray(data.jobs)) {
        jobsArray = data.jobs;
      } else if (data.searchResults && Array.isArray(data.searchResults)) {
        jobsArray = data.searchResults;
      }
      
      for (const job of jobsArray) {
        const jobTitle = job.jobTitle || job.title || job.positionTitle || job.name;
        const jobId = job.jobId || job.id || job.requisitionId;
        const location = job.location || job.city || job.state || job.country;
        const department = job.department || job.category;
        
        if (jobTitle && jobId) {
          const jobUrl = this.constructJobUrl(originalUrl, jobId);
          
          links.push({
            url: jobUrl,
            text: jobTitle,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.95,
            location: location,
            department: department
          });
          
          allText += `${jobTitle} `;
          if (location) allText += `${location} `;
          if (department) allText += `${department} `;
          allText += '\n';
        }
      }

      if (links.length > 0) {
        return {
          url: originalUrl,
          title: this.extractCompanyNameFromUrl(originalUrl),
          text: allText.trim(),
          links: links,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'iCIMS',
          jobTermsFound: this.countJobTerms(allText),
          isEmpty: false
        };
      }
    } catch (error) {
      config.smartLog('fail', `Error processing API data: ${error.message}`);
    }

    return null;
  }

  constructJobUrl(baseUrl, jobId) {
    const base = this.extractBaseUrl(baseUrl);
    return `${base}/jobs/${jobId}`;
  }

  async tryDirectScraping(url, options) {
    try {
      config.smartLog('steps', `Trying direct scraping for ${url}`);
      
      const response = await axios.get(url, {
        timeout: options.timeout || 15000,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': this.getAcceptLanguageHeader(),
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (response.data && response.data.length > 500) {
        const $ = cheerio.load(response.data);
        const result = this.extractICIMSContent($, url);
        
        if (result && (result.links.length > 0 || this.countJobTerms(result.text) > 5)) {
          config.smartLog('steps', `Direct scraping successful: ${result.links.length} links, ${this.countJobTerms(result.text)} job terms`);
          return result;
        }
      }
    } catch (error) {
      config.smartLog('fail', `Direct scraping failed: ${error.message}`);
    }

    return null;
  }

  extractICIMSContent($, url) {
    const links = [];
    const textParts = [];
    const processedUrls = new Set();
    
    const jobLinkSelectors = this.getJobListingSelectors();
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const icimsConfig = platforms.find(p => p.name === 'iCIMS');
    const icimsSelectors = icimsConfig?.selectors || [];
    
    const allSelectors = [...jobLinkSelectors, ...icimsSelectors];
    
    const titleExtractor = ($element) => {
      let title = $element.text().trim();
      
      if (!title || title.length < 3) {
        const $parent = $element.closest('tr, div[class*="job"], li');
        if ($parent.length) {
          const $titleElement = $parent.find('.job-title, .title, td:first-child, h3, h4').first();
          if ($titleElement.length) {
            title = $titleElement.text().trim();
          }
        }
      }
      
      return title;
    };
    
    for (const selector of allSelectors) {
      $(selector).each((index, element) => {
        const $link = $(element);
        const href = $link.attr('href');
        
        if (!href) return;
        
        const fullUrl = this.resolveUrl(href, url);
        
        if (processedUrls.has(fullUrl)) return;
        
        const text = titleExtractor($link);
        
        if (text && text.length > 3 && text.length < 200 && 
            !this.isGenericLink(text) && 
            this.isJobRelatedURL(fullUrl)) {
          
          processedUrls.add(fullUrl);
          
          const $row = $link.closest('tr, .job-item, .position-item, .iCIMS_JobListingRow');
          let location = '';
          let department = '';
          let jobId = '';
          
          if ($row.length > 0) {
            location = $row.find('.location, .job-location, td:nth-child(2), span[class*="location"]').text().trim() || '';
            department = $row.find('.department, .job-department, td:nth-child(3), span[class*="department"]').text().trim() || '';
            
            const jobIdMatch = href.match(/jobId=(\d+)|jobs\/(\d+)|job\/(\d+)/i);
            if (jobIdMatch) {
              jobId = jobIdMatch[1] || jobIdMatch[2] || jobIdMatch[3];
            }
          }
          
          links.push({
            url: fullUrl,
            text: text,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.9,
            location: location,
            department: department,
            jobId: jobId
          });
          
          textParts.push(`${text} ${location} ${department}`);
        }
      });
    }
    
    if (links.length === 0) {
      config.smartLog('steps', `No job links found with selectors, trying table parsing`);
      
      $('table.iCIMS_Table tr, table tr').each((index, row) => {
        const $row = $(row);
        const $cells = $row.find('td');
        
        if ($cells.length >= 2) {
          const $firstCell = $cells.first();
          const $link = $firstCell.find('a').first();
          
          if ($link.length > 0) {
            const href = $link.attr('href');
            const text = $link.text().trim() || $firstCell.text().trim();
            
            if (href && text && text.length > 5 && this.isValidJobTitle(text)) {
              const fullUrl = this.resolveUrl(href, url);
              
              if (!processedUrls.has(fullUrl) && this.isJobRelatedURL(fullUrl)) {
                processedUrls.add(fullUrl);
                
                const location = $cells.eq(1).text().trim() || '';
                const department = $cells.eq(2).text().trim() || '';
                
                links.push({
                  url: fullUrl,
                  text: text,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.85,
                  location: location,
                  department: department
                });
                
                textParts.push(`${text} ${location} ${department}`);
              }
            }
          }
        }
      });
    }
    
    const universal = dict.getUniversalSelectors();
    const contentSelectors = universal.contentZones || [
      '.iCIMS_MainWrapper',
      '.job-search-results',
      '.careers-home',
      '#main-content',
      '.job-postings',
      'table.iCIMS_Table',
      '.position-list',
      'tbody',
      '.job-results',
      '.search-results'
    ];
    
    for (const selector of contentSelectors) {
      const content = $(selector).text();
      if (content && content.trim().length > 50) {
        textParts.push(content.trim());
      }
    }
    
    $('title').each((index, element) => {
      textParts.push($(element).text());
    });
    
    $('meta[name="description"], meta[property="og:description"]').each((index, element) => {
      const content = $(element).attr('content');
      if (content) {
        textParts.push(content);
      }
    });
    
    const jobRelatedText = [];
    $('h1, h2, h3, h4').each((index, element) => {
      const text = $(element).text().trim();
      if (text && this.containsJobKeywords(text)) {
        jobRelatedText.push(text);
      }
    });
    textParts.push(...jobRelatedText);
    
    if (links.length === 0) {
      links.push(...this.createFallbackLinks($, url));
    }
    
    let combinedText = textParts.join(' ').replace(/\s+/g, ' ').trim();
    
    if (combinedText.length < 200) {
      const jobNavigationText = this.getJobNavigationTextSelectors();
      combinedText = `${combinedText} ${jobNavigationText.join(' ')}`;
    }
    
    return {
      url: url,
      title: $('title').text() || this.extractCompanyNameFromUrl(url),
      text: combinedText,
      links: links,
      scrapedAt: new Date().toISOString(),
      detectedPlatform: 'iCIMS',
      jobTermsFound: this.countJobTerms(combinedText),
      isEmpty: false
    };
  }

  isGenericLink(text) {
    const dict = this.getDictionary();
    const exclusionPatterns = dict.exclusionPatterns || [];
    
    const defaultGenericPatterns = [
      /^(home|about|contact|privacy|terms|careers?|jobs?)$/i,
      /^(search|filter|categories|locations)$/i,
      /^(sales|marketing|customer|business|support)(\s*>)?$/i,
      /^[^a-zA-Z]*$/,
      /^.{1,3}$/,
      /^(skip to|toggle|show|hide|close|open)/i,
      /^(©|copyright|all rights reserved)/i,
      /^(cookie|privacy|policy|terms|condition)/i
    ];
    
    const allPatterns = [...defaultGenericPatterns, ...exclusionPatterns];
    return allPatterns.some(pattern => pattern.test(text.trim()));
  }

  createFallbackLinks($, url) {
    const fallbackLinks = [];
    const jobs = this.parseJobsFromICIMSText($.text());
    
    if (jobs.length === 0) {
      const defaultJob = {
        url: `${url}#all-positions`,
        text: 'View All Positions',
        isJobPosting: true,
        linkType: 'job_listing',
        confidence: 0.5,
        location: '',
        department: ''
      };
      return [defaultJob];
    }
    
    return jobs.map((job, index) => ({
      url: `${url}#job-${index}`,
      text: job.title,
      isJobPosting: true,
      linkType: 'job_posting',
      confidence: 0.75,
      location: job.location,
      department: job.department
    }));
  }

  parseJobsFromICIMSText(text) {
    const jobs = [];
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const jobTitlePatterns = patterns.icimsJobTitlePatterns || [
      /^([A-Z][A-Za-z\s\-,&()]+(?:Manager|Engineer|Developer|Analyst|Specialist|Coordinator|Assistant|Director|Lead|Senior|Junior|Intern|Representative|Consultant|Executive|Supervisor|Technician|Associate|Administrator|Officer))/,
      /^([A-Z][A-Za-z\s\-,&()]{5,50})\s*[-–]\s*([A-Z][A-Za-z\s,]+)/,
      /(Apply\s+for|View)\s+([A-Z][A-Za-z\s\-,&()]+)/i,
      /^([A-Z][A-Za-z\s\-,&()]{10,80})$/
    ];
    
    const cleanedText = text
      .replace(/\s+/g, ' ')
      .replace(/\t/g, ' ')
      .trim();
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.length < 5 || trimmed.length > 150) continue;
      
      if (this.isNavigationContent(trimmed)) continue;
      
      for (const pattern of jobTitlePatterns) {
        const match = trimmed.match(pattern);
        if (match) {
          let title, location = '';
          
          if (match.length > 2) {
            title = match[1] ? match[1].trim() : match[2].trim();
            location = match[2] || '';
          } else {
            title = match[1].trim();
          }
          
          title = this.cleanJobTitle(title);
          
          if (title && title.length > 5 && this.isValidJobTitle(title)) {
            if (!jobs.some(job => job.title.toLowerCase() === title.toLowerCase())) {
              jobs.push({
                title: title,
                location: location.trim(),
                department: this.extractDepartmentFromTitle(title)
              });
            }
            break;
          }
        }
      }
    }
    
    if (jobs.length === 0) {
      jobs.push(...this.extractJobsFromStructuredContent(cleanedText));
    }
    
    return jobs.slice(0, 50);
  }

  isNavigationContent(text) {
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const navigationPatterns = patterns.icimsNavigationPatterns || [
      /^(home|about|contact|privacy|terms|careers?|jobs?|search|categories|locations)$/i,
      /^(sales|marketing|customer|business|support|technology)(\s*>)?$/i,
      /^(toggle navigation|skip to|see jobs by|copyright|all rights reserved)$/i,
      /^[^a-zA-Z]*$/,
      /^.{1,4}$/,
      /@/,
      /phone|email|address|©|cookie/i
    ];
    
    return navigationPatterns.some(pattern => pattern.test(text.trim()));
  }

  cleanJobTitle(title) {
    return title
      .replace(/^(Apply\s+for|View)\s+/i, '')
      .replace(/\s*>+\s*$/, '')
      .replace(/^\s*[-–]\s*/, '')
      .replace(/\s*[-–]\s*$/, '')
      .trim();
  }

  extractDepartmentFromTitle(title) {
    const dict = this.getDictionary();
    const universalPatterns = dict.get('departmentPatterns') || [];
    
    for (const pattern of universalPatterns) {
      const match = title.match(pattern);
      if (match) {
        return match[1] || match[0];
      }
    }
    
    const commonSuffixes = /\b(team|department|division|group|unit|dept)$/i;
    const words = title.toLowerCase().split(/\s+/);
    
    for (let i = 0; i < words.length - 1; i++) {
      if (commonSuffixes.test(words[i + 1])) {
        return words[i].charAt(0).toUpperCase() + words[i].slice(1);
      }
    }
    
    return '';
  }

  extractJobsFromStructuredContent(text) {
    const jobs = [];
    
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const structuredPatterns = patterns.icimsStructuredPatterns || [
      /(?:•|\*|\d+\.)\s*([A-Z][A-Za-z\s\-,&()]{10,80})/g,
      /<li[^>]*>([A-Z][A-Za-z\s\-,&()]{10,80})<\/li>/g,
      /[-–]\s*([A-Z][A-Za-z\s\-,&()]{10,80})/g
    ];
    
    for (const pattern of structuredPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const title = this.cleanJobTitle(match[1]);
        
        if (title && this.isValidJobTitle(title) && 
            !jobs.some(job => job.title.toLowerCase() === title.toLowerCase())) {
          jobs.push({
            title: title,
            location: '',
            department: this.extractDepartmentFromTitle(title)
          });
        }
      }
    }
    
    return jobs;
  }

  isValidJobTitle(title) {
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const invalidPatterns = patterns.icimsInvalidPatterns || [
      /^(home|about|contact|privacy|terms)/i,
      /^\d+$/,
      /^[^a-zA-Z]*$/,
      /(cookie|privacy|policy|terms|condition)/i,
      /^(skip|toggle|show|hide|close|open)/i
    ];
    
    const jobTerms = this.getJobTerms();
    
    const hasInvalidPattern = invalidPatterns.some(pattern => pattern.test(title));
    if (hasInvalidPattern) return false;
    
    const titleLower = title.toLowerCase();
    const hasValidKeyword = jobTerms.some(keyword => titleLower.includes(keyword.toLowerCase()));
    
    return title.length > 5 && title.length < 150 && (hasValidKeyword || title.split(' ').length >= 2);
  }

  containsJobKeywords(text) {
    const jobTerms = this.getJobTerms();
    const textLower = text.toLowerCase();
    return jobTerms.some(keyword => textLower.includes(keyword.toLowerCase()));
  }

  async tryHeadlessScraping(url, options) {
    try {
      config.smartLog('steps', `Trying headless scraping for ${url}`);
      
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: true,
          args: config.playwrightArgs || []
        });
      }
      
      const context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 }
      });
      
      const page = await context.newPage();
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await randomDelay(3000, 5000);
        
        await this.handleCommonModals(page);
        
        await this.waitForJobContent(page);
        
        await this.handleInteractiveElements(page);
        
        await randomDelay(2000, 3000);
        
        const content = await page.content();
        const $ = cheerio.load(content);
        const result = this.extractICIMSContent($, url);
        
        await page.close();
        await context.close();
        
        if (result && (result.links.length > 0 || this.countJobTerms(result.text) > 3)) {
          config.smartLog('steps', `Headless scraping successful: ${result.links.length} links`);
          return result;
        }
      } catch (error) {
        await page.close();
        await context.close();
        throw error;
      }
    } catch (error) {
      config.smartLog('fail', `Headless scraping failed: ${error.message}`);
    }
    
    return null;
  }

  async waitForJobContent(page) {
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const icimsConfig = platforms.find(p => p.name === 'iCIMS');
    const jobSelectors = icimsConfig?.selectors || [
      '.iCIMS_JobsTable',
      '.iCIMS_Table',
      '.job-item',
      '.icims-job-item', 
      'tr.icimsJobs',
      'table tbody tr',
      '.job-listing',
      '.position-item',
      'a[href*="job"]'
    ];
    
    let found = false;
    for (const selector of jobSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        config.smartLog('steps', `Found job content with selector: ${selector}`);
        found = true;
        break;
      } catch (error) {
        continue;
      }
    }
    
    if (!found) {
      config.smartLog('steps', `No specific job selectors found, waiting for general content`);
      await randomDelay(2000, 3000);
    }
  }

  async handleInteractiveElements(page) {
    await this.clickShowMoreButtons(page);
    await this.handlePagination(page);
    await this.handleSearchFilters(page);
  }

  async handleSearchFilters(page) {
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const filterResetSelectors = patterns.icimsFilterResetSelectors || [
      'a:has-text("Clear All")',
      'button:has-text("Reset")',
      'a:has-text("Show All")',
      '.clear-filters',
      '.reset-search'
    ];
    
    for (const selector of filterResetSelectors) {
      try {
        const isVisible = await page.isVisible(selector, { timeout: 1000 });
        if (isVisible) {
          config.smartLog('steps', `Clicking filter reset: ${selector}`);
          await page.click(selector);
          await randomDelay(2000, 3000);
          break;
        }
      } catch (error) {
        continue;
      }
    }
  }

  async handleCommonModals(page) {
    const cookieSelectors = this.getCookieSelectors();
    
    for (const selector of cookieSelectors) {
      try {
        const isVisible = await page.isVisible(selector, { timeout: 1000 });
        if (isVisible) {
          await page.click(selector);
          await randomDelay(500, 1000);
          break;
        }
      } catch (error) {
        continue;
      }
    }
  }

  async clickShowMoreButtons(page) {
    const showMoreSelectors = this.getShowMoreSelectors();
    
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      let clicked = false;
      
      for (const selector of showMoreSelectors) {
        try {
          const isVisible = await page.isVisible(selector, { timeout: 1000 });
          if (isVisible) {
            await page.click(selector);
            await randomDelay(2000, 3000);
            clicked = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      if (!clicked) break;
      attempts++;
    }
  }

  async handlePagination(page) {
    const paginationSelectors = this.getPaginationSelectors();
    
    let pageCount = 0;
    const maxPages = 5;
    
    while (pageCount < maxPages) {
      let clicked = false;
      
      for (const selector of paginationSelectors) {
        try {
          const isVisible = await page.isVisible(selector, { timeout: 1000 });
          if (isVisible) {
            await page.click(selector);
            await randomDelay(3000, 5000);
            clicked = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      if (!clicked) break;
      pageCount++;
    }
  }

  async exportDebugInfo(url, error) {
    try {
      const debugData = {
        url: url,
        error: error?.message || 'Unknown error',
        timestamp: new Date().toISOString(),
        step: this.name
      };
      
      await fs.writeFile(
        path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.json`),
        JSON.stringify(debugData, null, 2)
      );
    } catch (e) {}
  }

  extractBaseUrl(url) {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}`;
    } catch (error) {
      return null;
    }
  }

  extractCompanyNameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      
      if (hostname.includes('careers-')) {
        const match = hostname.match(/careers-([^.]+)/);
        if (match) {
          return match[1].charAt(0).toUpperCase() + match[1].slice(1);
        }
      }
      
      return hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
    } catch (error) {
      return 'Career Page';
    }
  }

  resolveUrl(href, baseUrl) {
    if (href.startsWith('http')) {
      return href;
    }
    
    try {
      return new URL(href, baseUrl).toString();
    } catch (error) {
      return href;
    }
  }

  isJobRelatedURL(url) {
    const jobUrlPatterns = this.getJobURLPatterns();
    return jobUrlPatterns.some(pattern => pattern.test(url.toLowerCase()));
  }

  countJobTerms(text) {
    if (!text || typeof text !== 'string') return 0;
    
    const jobTerms = this.getJobTerms();
    const lowerText = text.toLowerCase();
    let count = 0;
    
    for (const keyword of jobTerms) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = lowerText.match(regex);
      if (matches) {
        count += matches.length;
      }
    }
    
    return count;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  getStepMetadata() {
    return {
      name: this.name,
      description: 'Specialized scraper for iCIMS job boards with multi-method approach',
      priority: this.priority,
      platforms: ['iCIMS'],
      methods: ['icims-api', 'icims-direct', 'icims-headless'],
      apiEndpoints: this.platformConfig ? this.platformConfig.apiPatterns : [],
      features: [
        'Multi-endpoint API support',
        'Direct HTML parsing',
        'Headless browser fallback',
        'Modal handling',
        'Pagination support',
        'Show more button detection'
      ]
    };
  }
}

module.exports = iCIMSStep;