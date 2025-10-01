const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../../config');
const fs = require('fs').promises;
const path = require('path');

class ZohoRecruitStep extends BaseScraperStep {
  constructor() {
    super('zoho-recruit-step', 7);
    this.maxExecutionTime = 20000;
    this.apiTimeout = 12000;
    this.directTimeout = 15000;
    this.minRequestInterval = 1500;
    this.lastRequestTime = 0;
  }

  async isApplicable(url, prevStepResult = {}) {
    if (prevStepResult.detectedPlatform === 'ZohoRecruit') {
      config.smartLog('platform', `Platform detected as ZohoRecruit`);
      return true;
    }
    
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const zohoConfig = platforms.find(p => p.name === 'ZohoRecruit');
    
    if (zohoConfig && zohoConfig.patterns) {
      const urlLower = url.toLowerCase();
      const isZohoDomain = zohoConfig.patterns.some(pattern => urlLower.includes(pattern));
      
      if (isZohoDomain) {
        config.smartLog('platform', `ZohoRecruit domain detected in URL`);
        return true;
      }
    }
    
    if (prevStepResult.html || prevStepResult.htmlContent) {
      const html = prevStepResult.html || prevStepResult.htmlContent;
      const hasIndicators = this.detectPlatformInContent(html, zohoConfig);
      if (hasIndicators) {
        config.smartLog('platform', `ZohoRecruit indicators found in HTML`);
        return true;
      }
    }
    
    return false;
  }

  detectPlatformInContent(html, platformConfig) {
    if (!platformConfig || !platformConfig.indicators) return false;
    
    const lowerHtml = html.toLowerCase();
    return platformConfig.indicators.some(indicator => {
      if (indicator.includes('.*')) {
        const regex = new RegExp(indicator, 'i');
        return regex.test(lowerHtml);
      } else {
        return lowerHtml.includes(indicator.toLowerCase());
      }
    });
  }

  extractEmbedConfig(html) {
    config.smartLog('steps', `Extracting embed configuration`);
    
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const embedPatterns = patterns.embedConfigPatterns || [];
    
    for (const pattern of embedPatterns) {
      const match = html.match(new RegExp(pattern, 'i'));
      if (match) {
        config.smartLog('steps', `Found embed config with pattern`);
        const configStr = match[1];
        const config = {};
        
        const pairs = configStr.match(/(\w+)\s*:\s*["']([^"']+)["']/g);
        if (pairs) {
          pairs.forEach(pair => {
            const [key, value] = pair.split(/\s*:\s*/);
            if (key && value) {
              config[key.trim()] = value.replace(/["']/g, '').trim();
            }
          });
        }
        
        config.smartLog('steps', `Extracted config: ${JSON.stringify(config)}`);
        return config;
      }
    }
    
    config.smartLog('steps', `No embed config found`);
    return null;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);
    
    await this.respectRateLimit();
    
    const globalStartTime = Date.now();
    let result = null;
    let scrapingError = null;
    
    try {
      const initialHtml = await this.fetchInitialHtml(url, options);
      if (!initialHtml) {
        config.smartLog('fail', `Failed to fetch initial HTML`);
        scrapingError = new Error('Failed to fetch initial HTML');
        return null;
      }

      config.smartLog('steps', `HTML length: ${initialHtml.length}`);
      const $ = cheerio.load(initialHtml);
      
      const hasLoadingIndicators = this.hasLoadingIndicators($, initialHtml);
      const embedConfig = this.extractEmbedConfig(initialHtml);
      
      const platforms = dict.getKnownJobPlatforms();
      const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
      const isNativePortal = this.isNativePortal(url, platformConfig);
      const iframe = this.findPlatformIframe($, platformConfig);
      const hasIframe = iframe.length > 0;
      
      config.smartLog('steps', `Detection results: Native=${isNativePortal}, Config=${!!embedConfig}, Iframe=${hasIframe}, Dynamic=${hasLoadingIndicators}`);

      if (hasLoadingIndicators && isNativePortal) {
        config.smartLog('steps', `Native portal with dynamic loading detected - headless rendering required`);
        
        const hasPopup = this.detectPopupIndicators(initialHtml);
        
        result = {
          url: url,
          title: this.extractTitle(initialHtml),
          text: 'Jobs are loaded dynamically via JavaScript. Headless rendering required.',
          links: [{
            url: url,
            text: 'Dynamic loading - headless required',
            isJobPosting: false,
            linkType: 'dynamic_indicator',
            confidence: 1.0
          }],
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'ZohoRecruit',
          variantType: 'dynamic-native',
          jobTermsFound: 5,
          isEmpty: false,
          requiresJavaScript: true,
          requiresHeadless: true,
          hasPopup: hasPopup,
          method: 'dynamic-detection',
          executionTime: Date.now() - globalStartTime
        };
      } else {
        if (embedConfig && (embedConfig.site || embedConfig.page_name)) {
          result = await this.scrapeViaEmbedConfig(url, embedConfig, options);
        } else if (isNativePortal) {
          result = await this.scrapeNativePortalMode(url, options);
        } else if (hasIframe) {
          result = await this.scrapeIframeMode(url, iframe, $, options);
        } else {
          result = await this.scrapeFallbackMode(url, initialHtml, options);
        }
      }

      if (result && this.isValidResult(result)) {
        result.executionTime = Date.now() - globalStartTime;
        config.smartLog('win', `Success in ${result.executionTime}ms`);
      } else {
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

  isNativePortal(url, platformConfig) {
    if (!platformConfig || !platformConfig.nativePortalPatterns) return false;
    return platformConfig.nativePortalPatterns.some(pattern => url.includes(pattern));
  }

  findPlatformIframe($, platformConfig) {
    if (!platformConfig || !platformConfig.iframePatterns) return $();
    
    for (const pattern of platformConfig.iframePatterns) {
      const iframe = $(`iframe[src*="${pattern}"]`).first();
      if (iframe.length > 0) return iframe;
    }
    return $();
  }

  async fetchInitialHtml(url, options) {
    try {
      config.smartLog('steps', `Fetching initial HTML from ${url}`);
      const response = await axios.get(url, {
        timeout: 8000,
        headers: this.generateHeaders(),
        validateStatus: (status) => status < 500,
        maxRedirects: 5
      });

      if (response && response.data && response.status < 400) {
        config.smartLog('steps', `Fetched HTML successfully, status: ${response.status}, length: ${response.data.length}`);
        return response.data;
      }
      config.smartLog('fail', `Failed to fetch HTML, status: ${response?.status}`);
      return null;
    } catch (error) {
      config.smartLog('fail', `Failed to fetch initial HTML: ${error.message}`);
      return null;
    }
  }

  async scrapeViaEmbedConfig(originalUrl, config, options) {
    config.smartLog('steps', `Using embed config mode`);
    
    const site = config.site || originalUrl.match(/https?:\/\/[^\/]+/)?.[0];
    const pageName = config.page_name || config.pageName || 'Careers';
    const source = config.source || 'CareerSite';
    
    if (!site) {
      config.smartLog('fail', `No site found in embed config`);
      return null;
    }
    
    const dict = this.getDictionary();
    const platforms = dict.getKnownJobPlatforms();
    const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
    const apiEndpoints = platformConfig?.apiEndpoints || [];
    
    for (const endpoint of apiEndpoints) {
      const apiUrl = `${site}${endpoint}`;
      config.smartLog('steps', `Trying API endpoint: ${apiUrl}`);
      
      const jobs = await this.fetchJobsFromAPI(apiUrl, pageName, source, site);
      if (jobs && jobs.length > 0) {
        return this.formatAPIResult(jobs, originalUrl, 'embed-api');
      }
    }
    
    return null;
  }

  async scrapeNativePortalMode(url, options) {
    config.smartLog('steps', `Using Native Portal mode for ${url}`);
    
    try {
      const urlObj = new URL(url);
      const portal = `${urlObj.protocol}//${urlObj.hostname}`;
      const pathMatch = url.match(/\/jobs\/([^/?]+)/);
      const pageName = pathMatch ? pathMatch[1] : 'Careers';
      
      const html = await this.fetchInitialHtml(url, options);
      const apiHints = this.extractAPIHints(html);
      
      if (apiHints.apiUrl) {
        config.smartLog('steps', `Found API hint: ${apiHints.apiUrl}`);
        const jobs = await this.fetchJobsFromAPI(apiHints.apiUrl, apiHints.pageName || pageName, apiHints.source || 'CareerSite', apiHints.site || portal);
        
        if (jobs && jobs.length > 0) {
          return this.formatAPIResult(jobs, url, 'native-api');
        }
      }
      
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
      const apiEndpoints = platformConfig?.apiEndpoints || [];
      
      for (const endpoint of apiEndpoints) {
        const apiUrl = `${portal}${endpoint}`;
        config.smartLog('steps', `Trying API endpoint: ${apiUrl}`);
        const jobs = await this.fetchJobsFromAPI(apiUrl, pageName, 'CareerSite', portal);
        
        if (jobs && jobs.length > 0) {
          return this.formatAPIResult(jobs, url, 'native-api');
        }
      }
      
      if (html) {
        const inlineJobs = this.extractInlineJobData(html);
        if (inlineJobs.length > 0) {
          config.smartLog('steps', `Found ${inlineJobs.length} jobs in inline data`);
          return this.formatAPIResult(inlineJobs, url, 'native-inline');
        }
        
        const $ = cheerio.load(html);
        const htmlResult = this.extractJobsFromHtml($, html, url);
        if (htmlResult && htmlResult.links.length > 0) {
          htmlResult.variantType = 'native-html';
          return htmlResult;
        }
      }
      
      config.smartLog('fail', `All native portal methods failed`);
      return null;
      
    } catch (error) {
      config.smartLog('fail', `Native portal mode error: ${error.message}`);
      return null;
    }
  }
  
  extractAPIHints(html) {
    const hints = {};
    
    try {
      const dict = this.getDictionary();
      const patterns = dict.getPatterns();
      const apiHintPatterns = patterns.apiHintPatterns || [];
      
      for (const pattern of apiHintPatterns) {
        const match = html.match(new RegExp(pattern));
        if (match) {
          hints.apiUrl = match[1];
          config.smartLog('steps', `Found API URL hint: ${hints.apiUrl}`);
          break;
        }
      }
      
      const pageNameMatch = html.match(/pageName\s*[:=]\s*["']([^"']+)["']/);
      if (pageNameMatch) hints.pageName = pageNameMatch[1];
      
      const sourceMatch = html.match(/source\s*[:=]\s*["']([^"']+)["']/);
      if (sourceMatch) hints.source = sourceMatch[1];
      
    } catch (error) {
      config.smartLog('fail', `Error extracting API hints: ${error.message}`);
    }
    
    return hints;
  }

  async scrapeIframeMode(url, iframeElement, $, options) {
    config.smartLog('steps', `Using Iframe mode for ${url}`);
    
    try {
      const iframeSrc = iframeElement.attr('src');
      if (!iframeSrc) {
        config.smartLog('fail', `No src attribute found in iframe`);
        return null;
      }
      
      const iframeUrl = new URL(iframeSrc, url);
      const portal = `${iframeUrl.protocol}//${iframeUrl.hostname}`;
      
      const iframeHtml = await this.fetchInitialHtml(iframeSrc, options);
      if (iframeHtml) {
        const $iframe = cheerio.load(iframeHtml);
        
        const encodedJobs = this.extractEncodedJson($iframe, iframeHtml);
        if (encodedJobs.length > 0) {
          config.smartLog('steps', `Found ${encodedJobs.length} jobs in iframe encoded data`);
          const text = this.cleanText(iframeHtml);
          const jobTermsFound = this.countJobTerms(text);
          
          return {
            url: url,
            title: this.extractTitle(iframeHtml) || this.extractTitle($.html()),
            text: text,
            links: encodedJobs,
            scrapedAt: new Date().toISOString(),
            detectedPlatform: 'ZohoRecruit',
            variantType: 'iframe-encoded',
            jobTermsFound: jobTermsFound,
            isEmpty: false,
            method: 'iframe'
          };
        }
        
        const iframeJobs = this.extractJobsFromHtml($iframe, iframeHtml, iframeSrc);
        if (iframeJobs && iframeJobs.links.length > 0) {
          config.smartLog('steps', `Found ${iframeJobs.links.length} jobs in iframe HTML`);
          iframeJobs.url = url;
          iframeJobs.title = this.extractTitle($.html()) || iframeJobs.title;
          iframeJobs.variantType = 'iframe-html';
          return iframeJobs;
        }
      }
      
      config.smartLog('fail', `All iframe methods failed`);
      return null;
      
    } catch (error) {
      config.smartLog('fail', `Iframe mode error: ${error.message}`);
      return null;
    }
  }

  async scrapeFallbackMode(url, html, options) {
    config.smartLog('steps', `Using Fallback mode for ${url}`);
    
    const $ = cheerio.load(html);
    
    const angularData = this.extractAngularData($, html);
    if (angularData.length > 0) {
      config.smartLog('steps', `Found ${angularData.length} jobs in Angular data`);
      return this.formatAPIResult(angularData, url, 'angular-data');
    }
    
    const inlineJobs = this.extractInlineJobData(html);
    if (inlineJobs.length > 0) {
      config.smartLog('steps', `Found ${inlineJobs.length} jobs in inline JSON`);
      return this.formatAPIResult(inlineJobs, url, 'inline-json');
    }
    
    const scriptJobs = this.extractJobsFromScripts($, html);
    if (scriptJobs.length > 0) {
      config.smartLog('steps', `Found ${scriptJobs.length} jobs in script tags`);
      const text = this.cleanText(html);
      const jobTermsFound = this.countJobTerms(text);
      
      return {
        url: url,
        title: this.extractTitle(html),
        text: text,
        links: scriptJobs,
        scrapedAt: new Date().toISOString(),
        detectedPlatform: 'ZohoRecruit',
        variantType: 'script-data',
        jobTermsFound: jobTermsFound,
        isEmpty: false,
        method: 'fallback'
      };
    }
    
    const result = this.extractJobsFromHtml($, html, url);
    if (result && result.links.length > 0) {
      config.smartLog('steps', `Found ${result.links.length} jobs in HTML`);
      return result;
    }
    
    config.smartLog('fail', `No jobs found in fallback mode`);
    return null;
  }
  
  extractAngularData($, html) {
    const jobs = [];
    
    try {
      $('script[type="application/json"]').each((index, script) => {
        const content = $(script).html();
        if (content) {
          try {
            const data = JSON.parse(content);
            if (data && typeof data === 'object') {
              const checkForJobs = (obj) => {
                if (Array.isArray(obj)) {
                  for (const item of obj) {
                    if (item && (item.jobTitle || item.title || item.position)) {
                      jobs.push(item);
                    }
                  }
                } else if (obj && typeof obj === 'object') {
                  for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                      checkForJobs(obj[key]);
                    }
                  }
                }
              };
              checkForJobs(data);
            }
          } catch (e) {}
        }
      });
    } catch (error) {
      config.smartLog('fail', `Error extracting Angular data: ${error.message}`);
    }
    
    return jobs;
  }

  async fetchJobsFromAPI(apiUrl, pageName, source = 'CareerSite', site = '') {
    const allJobs = [];
    let pageNo = 1;
    let hasMore = true;
    const recordsPerPage = 50;
    
    while (hasMore && pageNo <= 10) {
      try {
        await this.respectRateLimit();
        
        const params = {
          pageName: pageName,
          source: source,
          pageNo: pageNo,
          recordsPerPage: recordsPerPage,
          sort: 'publisheddate,DESC'
        };
        
        if (site) params.site = site;
        
        config.smartLog('steps', `Fetching page ${pageNo} from API: ${apiUrl}`);
        
        const response = await axios({
          method: 'GET',
          url: apiUrl,
          params: params,
          headers: {
            ...this.generateHeaders(),
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': site || apiUrl
          },
          timeout: this.apiTimeout,
          validateStatus: (status) => status < 500
        });
        
        if (response.status === 404) {
          config.smartLog('fail', `404 error, breaking pagination`);
          break;
        }
        
        if (response.data) {
          let data;
          if (typeof response.data === 'string') {
            if (response.data.trim().startsWith('<!DOCTYPE') || response.data.trim().startsWith('<html')) {
              config.smartLog('fail', `Response is HTML, not JSON - API might need authentication`);
              hasMore = false;
              continue;
            }
            
            const jsonpMatch = response.data.match(/^[^(]+\((.*)\);?$/);
            if (jsonpMatch) {
              try {
                data = JSON.parse(jsonpMatch[1]);
              } catch (e) {
                config.smartLog('fail', `Failed to parse JSONP: ${e.message}`);
              }
            } else {
              try {
                data = JSON.parse(response.data);
              } catch (parseError) {
                config.smartLog('fail', `Failed to parse JSON: ${parseError.message}`);
                hasMore = false;
                continue;
              }
            }
          } else {
            data = response.data;
          }
          
          if (data) {
            if (data.jobDetails && Array.isArray(data.jobDetails)) {
              config.smartLog('steps', `Found ${data.jobDetails.length} jobs on page ${pageNo}`);
              allJobs.push(...data.jobDetails);
              hasMore = data.hasMoreRecords === true;
            } else if (Array.isArray(data)) {
              config.smartLog('steps', `Found ${data.length} jobs (array response)`);
              allJobs.push(...data);
              hasMore = false;
            } else if (data.jobs && Array.isArray(data.jobs)) {
              config.smartLog('steps', `Found ${data.jobs.length} jobs in data.jobs`);
              allJobs.push(...data.jobs);
              hasMore = data.hasMore || data.nextPage || false;
            } else if (data.content && Array.isArray(data.content)) {
              config.smartLog('steps', `Found ${data.content.length} jobs in data.content`);
              allJobs.push(...data.content);
              hasMore = data.hasMore || data.hasNext || false;
            } else {
              config.smartLog('fail', `Unexpected API response structure`);
              hasMore = false;
            }
          }
        } else {
          config.smartLog('fail', `No data in response`);
          hasMore = false;
        }
        
        pageNo++;
        
      } catch (error) {
        config.smartLog('fail', `API error on page ${pageNo}: ${error.message}`);
        hasMore = false;
      }
    }
    
    config.smartLog('steps', `Total jobs fetched from API: ${allJobs.length}`);
    return allJobs;
  }

  formatAPIResult(jobsData, originalUrl, variantType) {
    const links = [];
    let allText = '';
    
    let portalUrl = originalUrl;
    try {
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
      
      if (platformConfig && platformConfig.patterns.some(pattern => originalUrl.includes(pattern))) {
        const urlObj = new URL(originalUrl);
        portalUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      } else {
        if (jobsData.length > 0 && jobsData[0].PORTAL_URL) {
          portalUrl = jobsData[0].PORTAL_URL;
        }
      }
    } catch (e) {
      config.smartLog('fail', `Error parsing portal URL: ${e.message}`);
    }
    
    for (const job of jobsData) {
      const title = job.JOB_TITLE || job.Job_Title || job.Posting_Title || job.title || '';
      if (!title || !this.isValidJobTitle(title)) continue;
      
      const jobId = job.JOB_OPENING_ID || job.id || job.Id || '';
      const publishedDate = job.PUBLISHED_DATE || job.Date_Opened || '';
      const location = [
        job.CITY || job.City || '',
        job.STATE || job.State || '',
        job.COUNTRY || job.Country || ''
      ].filter(Boolean).join(', ');
      
      const workType = job.JOB_TYPE || job.Job_Type || (job.Remote_Job ? 'Remote' : '') || '';
      const department = job.DEPARTMENT || job.Department || job.Industry || '';
      
      let jobUrl = '';
      if (job.JOB_URL) {
        jobUrl = job.JOB_URL;
      } else if (jobId) {
        const dict = this.getDictionary();
        const platforms = dict.getKnownJobPlatforms();
        const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
        
        if (platformConfig && platformConfig.patterns.some(pattern => portalUrl.includes(pattern))) {
          jobUrl = `${portalUrl}/jobs/Careers/${jobId}`;
        } else {
          jobUrl = `${originalUrl}/${jobId}/view`;
        }
      } else {
        jobUrl = `${originalUrl}#job-${links.length}`;
      }
      
      links.push({
        url: jobUrl,
        text: title,
        isJobPosting: true,
        linkType: 'job_posting',
        confidence: 0.95,
        location: location,
        department: department,
        workType: workType,
        publishedDate: publishedDate
      });
      
      allText += `${title} ${location} ${workType} ${department}\n`;
    }
    
    return {
      url: originalUrl,
      title: this.extractCompanyNameFromUrl(originalUrl) || 'Career Opportunities',
      text: allText.trim(),
      links: links,
      scrapedAt: new Date().toISOString(),
      detectedPlatform: 'ZohoRecruit',
      variantType: variantType,
      jobTermsFound: this.countJobTerms(allText),
      isEmpty: links.length === 0,
      method: 'api'
    };
  }

  extractJobsFromHtml($, html, url) {
    const jobs = [];
    
    config.smartLog('steps', `Extracting jobs from HTML`);
    
    const dict = this.getDictionary();
    const jobListingSelectors = dict.getJobListingSelectors();
    const platforms = dict.getKnownJobPlatforms();
    const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
    const platformSelectors = platformConfig?.selectors || [];
    
    const allSelectors = [...jobListingSelectors, ...platformSelectors];
    
    for (const selector of allSelectors) {
      const elements = $(selector);
      config.smartLog('steps', `Trying selector "${selector}" - found ${elements.length} elements`);
      
      if (elements.length > 0) {
        elements.each((index, element) => {
          const $el = $(element);
          let title = '';
          let jobUrl = '';
          let location = '';
          let department = '';
          
          const titleSelectors = ['.job-title', '.position-title', '.opening-title', 'h3', 'h4', 'a'];
          for (const titleSel of titleSelectors) {
            const $title = $el.find(titleSel).first();
            if ($title.length && $title.text().trim()) {
              title = $title.text().trim();
              if ($title.is('a')) {
                jobUrl = $title.attr('href');
              }
              break;
            }
          }
          
          const locationSelectors = ['.location', '.job-location', '.city', '[class*="location"]'];
          for (const locSel of locationSelectors) {
            const $loc = $el.find(locSel).first();
            if ($loc.length) {
              location = $loc.text().trim();
              break;
            }
          }
          
          if (!jobUrl && $el.attr('onclick')) {
            const onclick = $el.attr('onclick');
            const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)['"]/);
            if (urlMatch) {
              jobUrl = urlMatch[1];
            }
          }
          
          if (title && this.isValidJobTitle(title)) {
            if (jobUrl && !jobUrl.startsWith('http')) {
              try {
                jobUrl = new URL(jobUrl, url).href;
              } catch (e) {
                jobUrl = `${url}${jobUrl.startsWith('/') ? '' : '/'}${jobUrl}`;
              }
            }
            
            jobs.push({
              url: jobUrl || `${url}#job-${jobs.length}`,
              text: title,
              isJobPosting: true,
              linkType: 'job_posting',
              confidence: 0.9,
              location: location,
              department: department,
              workType: ''
            });
          }
        });
        
        if (jobs.length > 0) break;
      }
    }
    
    if (jobs.length === 0) {
      const tables = $('table');
      
      tables.each((tableIndex, table) => {
        const $table = $(table);
        const rows = $table.find('tr');
        
        rows.each((rowIndex, row) => {
          const $row = $(row);
          const cells = $row.find('td');
          
          if (cells.length >= 2) {
            const firstCellText = cells.eq(0).text().trim();
            if (/\w+\s+\d{1,2}\s+\d{4}/.test(firstCellText)) {
              const $titleCell = cells.eq(1);
              const title = $titleCell.text().trim();
              const $link = $titleCell.find('a').first();
              let jobUrl = '';
              if ($link.length) {
                jobUrl = $link.attr('href');
              }
              
              if (title && this.isValidJobTitle(title)) {
                if (jobUrl && !jobUrl.startsWith('http')) {
                  try {
                    jobUrl = new URL(jobUrl, url).href;
                  } catch (e) {
                    jobUrl = `${url}${jobUrl.startsWith('/') ? '' : '/'}${jobUrl}`;
                  }
                }
                
                jobs.push({
                  url: jobUrl || `${url}#job-${jobs.length}`,
                  text: title,
                  isJobPosting: true,
                  linkType: 'job_posting',
                  confidence: 0.85,
                  location: '',
                  department: '',
                  workType: ''
                });
              }
            }
          }
        });
        
        if (jobs.length > 0) {
          config.smartLog('steps', `Found ${jobs.length} jobs in table ${tableIndex}`);
          return false;
        }
      });
    }
    
    const text = this.cleanText(html);
    const jobTermsFound = this.countJobTerms(text);
    
    config.smartLog('steps', `HTML extraction complete: ${jobs.length} jobs, ${jobTermsFound} job terms`);
    
    return {
      url: url,
      title: this.extractTitle(html),
      text: text,
      links: jobs,
      scrapedAt: new Date().toISOString(),
      detectedPlatform: 'ZohoRecruit',
      variantType: 'html',
      jobTermsFound: jobTermsFound,
      isEmpty: jobs.length === 0,
      method: 'html'
    };
  }

  detectPopupIndicators(html) {
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const popupIndicators = patterns.popupIndicators || [
      'Career Helper', 'AI Assistant', 'chat-widget', 'popup-modal',
      'overlay-dialog', 'modal-backdrop', 'Find matching jobs', 'Register to portal'
    ];
    
    for (const indicator of popupIndicators) {
      if (html.includes(indicator)) {
        config.smartLog('steps', `Popup indicator found: ${indicator}`);
        return true;
      }
    }
    
    return false;
  }

  hasLoadingIndicators($, html) {
    const dict = this.getDictionary();
    const loadingSelectors = dict.getLoadingIndicators();
    const dynamicIndicators = dict.getDynamicContentIndicators();
    
    for (const indicator of [...loadingSelectors, ...dynamicIndicators]) {
      if ($(indicator).length > 0 || html.includes(indicator)) {
        return true;
      }
    }
    
    const containerSelectors = [
      '#rec_job_listing_div',
      '.job-listing-container',
      '.careers-container',
      '[class*="job-container"]',
      '#cw-container',
      '.cw-page-container',
      '.current-openings',
      '[class*="openings"]'
    ];
    
    for (const selector of containerSelectors) {
      const container = $(selector);
      if (container.length > 0) {
        const jobLikeChildren = container.find('a, .job, .opening, .position, tr, .listing');
        if (jobLikeChildren.length === 0) {
          config.smartLog('steps', `Empty container found: ${selector}`);
          return true;
        }
      }
    }
    
    return false;
  }

  extractInlineJobData(html) {
    const jobs = [];
    
    try {
      const dict = this.getDictionary();
      const patterns = dict.getPatterns();
      const inlineDataPatterns = patterns.inlineJobDataPatterns || [
        /window\.jobData\s*=\s*(\[[\s\S]*?\]);/,
        /window\.careerData\s*=\s*(\[[\s\S]*?\]);/,
        /var\s+jobListings\s*=\s*(\[[\s\S]*?\]);/,
        /var\s+openings\s*=\s*(\[[\s\S]*?\]);/,
        /jobOpenings\s*:\s*(\[[\s\S]*?\])/,
        /"jobOpenings"\s*:\s*(\[[\s\S]*?\])/
      ];
      
      for (const pattern of inlineDataPatterns) {
        const match = html.match(pattern);
        if (match) {
          try {
            let jsonStr = match[1];
            jsonStr = jsonStr.replace(/\\'/g, "'").replace(/\\"/g, '"');
            
            const data = JSON.parse(jsonStr);
            
            if (Array.isArray(data)) {
              return data;
            } else if (data && typeof data === 'object') {
              for (const key in data) {
                if (Array.isArray(data[key]) && data[key].length > 0) {
                  const firstItem = data[key][0];
                  if (firstItem && (firstItem.title || firstItem.jobTitle || firstItem.position || firstItem.JOB_TITLE)) {
                    return data[key];
                  }
                }
              }
            }
          } catch (e) {
            config.smartLog('fail', `Failed to parse inline job data: ${e.message}`);
          }
        }
      }
      
    } catch (error) {
      config.smartLog('fail', `Error extracting inline job data: ${error.message}`);
    }
    
    return jobs;
  }
  
  extractJobsFromScripts($, html) {
    const jobs = [];
    
    try {
      $('script').each((index, script) => {
        const scriptContent = $(script).html();
        if (!scriptContent) return;
        
        if (scriptContent.includes('Posting_Title') || 
            scriptContent.includes('Job_Title') || 
            scriptContent.includes('JOB_TITLE')) {
          
          const arrayMatches = scriptContent.match(/\[[\s\S]*?\]/g);
          if (arrayMatches) {
            for (const arrayStr of arrayMatches) {
              try {
                const data = JSON.parse(arrayStr);
                if (Array.isArray(data) && data.length > 0) {
                  for (const item of data) {
                    if (item && typeof item === 'object' && 
                        (item.Posting_Title || item.Job_Title || item.JOB_TITLE)) {
                      this.addJobFromData(item, jobs);
                    }
                  }
                }
              } catch (e) {}
            }
          }
        }
      });
    } catch (error) {
      config.smartLog('fail', `Error extracting jobs from scripts: ${error.message}`);
    }
    
    return jobs;
  }

  extractEncodedJson($, html) {
    const jobs = [];
    
    try {
      $('input[type="hidden"]').each((index, input) => {
        const value = $(input).attr('value');
        if (value && (value.includes('Posting_Title') || value.includes('Job_Opening_Name') || value.includes('JOB_TITLE'))) {
          try {
            const decoded = this.decodeHtmlEntities(value);
            const jsonData = JSON.parse(decoded);
            
            if (Array.isArray(jsonData)) {
              for (const job of jsonData) {
                if (job && (job.Posting_Title || job.Job_Opening_Name || job.JOB_TITLE)) {
                  this.addJobFromData(job, jobs);
                }
              }
            }
          } catch (parseError) {}
        }
      });
    } catch (error) {
      config.smartLog('fail', `Error extracting encoded JSON: ${error.message}`);
    }
    
    return jobs;
  }

  addJobFromData(jobData, jobs) {
    const title = jobData.Posting_Title || jobData.Job_Opening_Name || jobData.JOB_TITLE || '';
    if (!title || !this.isValidJobTitle(title)) return;
    
    const location = [
      jobData.City || jobData.CITY || '',
      jobData.State || jobData.STATE || '',
      jobData.Country || jobData.COUNTRY || ''
    ].filter(Boolean).join(', ');
    
    const workType = jobData.Remote_Job ? 'Remote' : jobData.Job_Type || jobData.JOB_TYPE || '';
    const jobId = jobData.id || jobData.JOB_OPENING_ID || '';
    
    jobs.push({
      url: jobId ? `#job-${jobId}` : `#job-${jobs.length}`,
      text: title,
      isJobPosting: true,
      linkType: 'job_posting',
      confidence: 0.95,
      location: location,
      department: jobData.Industry || jobData.DEPARTMENT || '',
      workType: workType
    });
  }

  async respectRateLimit() {
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      const delay = this.minRequestInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    this.lastRequestTime = Date.now();
  }

  generateHeaders() {
    const dict = this.getDictionary();
    const universal = dict.getUniversalSelectors();
    const userAgents = universal.userAgents || [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    
    const currentLang = dict.getCurrentLanguage();
    const languageHeaders = universal.languageHeaders || {};
    const acceptLanguage = languageHeaders[currentLang] || 'en-US,en;q=0.9';
    
    return {
      'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };
  }

  decodeHtmlEntities(text) {
    const dict = this.getDictionary();
    const patterns = dict.getPatterns();
    const entityMap = patterns.htmlEntityMap || {
      '&#x7b;': '{', '&#x7d;': '}', '&#x3a;': ':', '&#x20;': ' ', '&#x2c;': ',',
      '&#x5b;': '[', '&#x5d;': ']', '&#x22;': '"', '&#x27;': "'", '&#x5c;': '\\',
      '&#x2f;': '/', '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>',
      '&nbsp;': ' '
    };
    
    let decoded = text;
    
    decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
      return String.fromCharCode(parseInt(dec, 10));
    });
    
    for (const [entity, char] of Object.entries(entityMap)) {
      decoded = decoded.replace(new RegExp(entity, 'gi'), char);
    }
    
    return decoded;
  }

  isValidJobTitle(title) {
    if (!title || typeof title !== 'string') return false;
    
    const cleaned = title.trim();
    if (cleaned.length < 3 || cleaned.length > 150) return false;
    
    const dict = this.getDictionary();
    const exclusionPatterns = dict.exclusionPatterns || [];
    
    const hasInvalidPattern = exclusionPatterns.some(pattern => pattern.test(cleaned));
    if (hasInvalidPattern) return false;
    
    const jobTerms = this.getJobTerms();
    const cleanedLower = cleaned.toLowerCase();
    const hasJobKeyword = jobTerms.some(keyword => cleanedLower.includes(keyword.toLowerCase()));
    
    return hasJobKeyword || cleaned.split(' ').length >= 2;
  }

  isValidResult(result) {
    if (!result || typeof result !== 'object') {
      config.smartLog('fail', `Invalid result: not an object`);
      return false;
    }
    
    if (!result.hasOwnProperty('links') || !Array.isArray(result.links)) {
      config.smartLog('fail', `Invalid result: no links array`);
      return false;
    }
    
    if (result.requiresJavaScript || result.requiresHeadless) {
      if (result.variantType && result.variantType.includes('dynamic')) {
        config.smartLog('steps', `Valid result: dynamic loading detected, headless rendering required`);
        return true;
      }
    }
    
    if (!result.text || result.text.trim().length < 10) {
      config.smartLog('fail', `Invalid result: text too short (${result.text?.length || 0} chars)`);
      return false;
    }
    
    const jobTermsFound = result.jobTermsFound || 0;
    const linksCount = result.links.length;
    
    if (linksCount > 0) {
      const validLinks = result.links.filter(link => 
        link && link.text && link.text.trim().length > 3 && this.isValidJobTitle(link.text)
      );
      if (validLinks.length > 0) {
        config.smartLog('steps', `Valid result: ${validLinks.length} valid links out of ${linksCount}`);
        return true;
      }
    }
    
    if (result.detectedPlatform === 'ZohoRecruit' && jobTermsFound >= 1 && result.text.length > 20) {
      config.smartLog('steps', `Accepting ZohoRecruit result with ${linksCount} links and ${jobTermsFound} job terms`);
      return true;
    }
    
    config.smartLog('fail', `Rejecting result: ${linksCount} links, ${jobTermsFound} job terms, ${result.text.length} chars`);
    return false;
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

  extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : 'Career Page';
  }

  extractCompanyNameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      
      const dict = this.getDictionary();
      const platforms = dict.getKnownJobPlatforms();
      const platformConfig = platforms.find(p => p.name === 'ZohoRecruit');
      
      if (platformConfig && platformConfig.patterns.some(pattern => hostname.includes(pattern))) {
        const subdomain = hostname.split('.')[0];
        return subdomain.charAt(0).toUpperCase() + subdomain.slice(1).replace(/[-_]/g, ' ');
      }
      
      const parts = hostname.split('.');
      const domain = parts[0];
      
      const cleanedDomain = domain.replace(/^(www|careers|jobs|hr|recruiting|talent)\.?/i, '');
      
      return cleanedDomain.charAt(0).toUpperCase() + cleanedDomain.slice(1).replace(/[-_]/g, ' ');
    } catch (error) {
      return 'Company';
    }
  }

  cleanText(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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

  getStepMetadata() {
    const dict = this.getDictionary();
    return {
      name: this.name,
      description: 'Universal step for platforms with enhanced parsing, dynamic detection, and multiple extraction methods',
      priority: this.priority,
      platforms: ['ZohoRecruit'],
      methods: [
        'embed-api', 'iframe', 'iframe-api', 'iframe-encoded', 'iframe-html',
        'widget-api', 'native-api', 'native-inline', 'native-html',
        'inline-json', 'script-data', 'angular-data', 'template-data',
        'legacy-api', 'html', 'encoded', 'dynamic', 'dynamic-native',
        'dynamic-detection', 'fallback-api'
      ],
      features: [
        'Universal platform detection via dictionaries',
        'Dynamic loading detection with smart indicators',
        'Popup detection via configurable patterns',
        'Multi-method extraction approach',
        'Intelligent logging system',
        'Conditional debug export',
        'Language-aware header generation',
        'Generic HTML entity decoding',
        'Pattern-based job validation'
      ],
      supportedLanguages: dict.getSupportedLanguages()
    };
  }
}

module.exports = ZohoRecruitStep;