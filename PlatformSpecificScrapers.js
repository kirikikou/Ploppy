const dictionaries = require('../dictionaries');
const config = require('../config');

class PlatformSpecificScrapers {
  constructor() {
    this.scrapers = {
      recruitee: this.universalStrategy,
      jobvite: this.universalStrategy,
      bamboohr: this.universalStrategy,
      greenhouse: this.universalStrategy,
      workday: this.universalStrategy,
      linkedin: this.universalStrategy,
      indeed: this.universalStrategy,
      glassdoor: this.universalStrategy,
      lever: this.universalStrategy,
      smartrecruiters: this.universalStrategy,
      taleo: this.universalStrategy,
      icims: this.universalStrategy,
      workable: this.universalStrategy,
      teamtailor: this.universalStrategy,
      personio: this.universalStrategy,
      ashby: this.universalStrategy
    };
  }

  async scrape(url, platform, browser, options = {}) {
    const platformLower = platform ? platform.toLowerCase() : null;
    
    if (!platformLower || !this.scrapers[platformLower]) {
      config.smartLog('platform', `Using universal strategy for unknown platform: ${platform}`);
      return await this.universalStrategy(url, browser, options, platform);
    }
    
    try {
      config.smartLog('platform', `Using specialized strategy for ${platform}`);
      return await this.scrapers[platformLower].call(this, url, browser, options, platform);
    } catch (error) {
      config.smartLog('fail', `Error with ${platform} scraper: ${error.message}`);
      return null;
    }
  }

  async universalStrategy(url, browser, options = {}, platformName = null) {
    const page = await browser.newPage();
    try {
      await this.setupPage(page);
      
      const platformConfig = platformName ? 
        dictionaries.knownJobPlatforms.find(p => p.name === platformName) : null;
      
      const testUrls = this.generateTestUrls(url, platformConfig);
      
      for (const testUrl of testUrls) {
        try {
          config.smartLog('platform', `Trying URL: ${testUrl}`);
          await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 45000 });
          
          await this.handlePageSetup(page);
          
          if (await this.detectBlockingContent(page)) {
            config.smartLog('platform', `Blocking content detected, skipping ${testUrl}`);
            continue;
          }
          
          await this.handleDynamicContent(page);
          
          const result = await this.extractUniversalJobContent(page, testUrl, platformName);
          
          if (result && result.links && result.links.length > 0) {
            config.smartLog('platform', `Success with ${testUrl}: ${result.links.length} jobs found`);
            return result;
          }
          
        } catch (error) {
          config.smartLog('platform', `Failed with ${testUrl}: ${error.message}`);
          continue;
        }
      }
      
      config.smartLog('platform', `All URLs failed for platform ${platformName}`);
      return null;
      
    } finally {
      await page.close();
    }
  }

  generateTestUrls(url, platformConfig) {
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    
    const commonPaths = [
      '',
      '/careers',
      '/jobs',
      '/positions',
      '/opportunities',
      '/openings',
      '/work-with-us',
      '/join-us',
      '/employment',
      '/vacancy',
      '/vacancies'
    ];
    
    const langPaths = [
      '/en/careers',
      '/en/jobs',
      '/fr/carrieres',
      '/fr/emplois',
      '/de/karriere',
      '/de/jobs',
      '/es/empleos',
      '/es/trabajos',
      '/it/lavoro',
      '/it/carriere',
      '/nl/vacatures',
      '/nl/banen'
    ];
    
    let testUrls = [url];
    
    for (const path of commonPaths) {
      const testUrl = baseUrl + path;
      if (!testUrls.includes(testUrl)) {
        testUrls.push(testUrl);
      }
    }
    
    for (const path of langPaths) {
      const testUrl = baseUrl + path;
      if (!testUrls.includes(testUrl)) {
        testUrls.push(testUrl);
      }
    }
    
    if (platformConfig && platformConfig.patterns) {
      for (const pattern of platformConfig.patterns) {
        if (pattern.includes('.')) {
          const testUrl = `https://${pattern}`;
          if (!testUrls.includes(testUrl)) {
            testUrls.push(testUrl);
          }
        }
      }
    }
    
    return testUrls.slice(0, 8);
  }

  async handlePageSetup(page) {
    await page.waitForTimeout(2000);
    
    await this.handleCookieConsent(page);
    await this.waitForInitialContent(page);
  }

  async handleCookieConsent(page) {
    try {
      const cookieSelectors = dictionaries.cookieSelectors;
      const cookieTextSelectors = dictionaries.cookieTextSelectors;
      
      for (const selector of cookieSelectors.slice(0, 10)) {
        try {
          const element = await page.$(selector);
          if (element && await element.isVisible()) {
            config.smartLog('platform', `Accepting cookies with: ${selector}`);
            await element.click();
            await page.waitForTimeout(1000);
            return;
          }
        } catch (e) {}
      }
      
      const buttons = await page.$$('button, a[role="button"], [role="button"]');
      for (const button of buttons.slice(0, 15)) {
        try {
          const text = await button.textContent();
          if (text && cookieTextSelectors.some(textPattern => 
            text.toLowerCase().includes(textPattern.toLowerCase())
          )) {
            config.smartLog('platform', `Accepting cookies by text: ${text.substring(0, 30)}`);
            await button.click();
            await page.waitForTimeout(1000);
            return;
          }
        } catch (e) {}
      }
    } catch (error) {
      config.smartLog('platform', `Cookie consent handling failed: ${error.message}`);
    }
  }

  async waitForInitialContent(page) {
    const jobListingSelectors = dictionaries.jobListingSelectors.slice(0, 15);
    
    try {
      await page.waitForFunction((selectors) => {
        const jobElements = document.querySelectorAll(selectors.join(', '));
        return jobElements.length > 0 || document.body.innerText.length > 500;
      }, jobListingSelectors, { timeout: 10000 });
    } catch (error) {
      config.smartLog('platform', `Initial content wait timeout: ${error.message}`);
    }
    
    await page.waitForTimeout(3000);
  }

  async detectBlockingContent(page) {
    try {
      const blockingSelectors = dictionaries.blockingContentSelectors;
      const blockingTextSelectors = dictionaries.blockingTextSelectors;
      
      const hasBlockingElements = await page.evaluate((selectors) => {
        for (const selector of selectors.slice(0, 10)) {
          try {
            const element = document.querySelector(selector);
            if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
              return true;
            }
          } catch (e) {}
        }
        return false;
      }, blockingSelectors);
      
      if (hasBlockingElements) return true;
      
      const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
      
      return blockingTextSelectors.some(text => 
        pageText.includes(text.toLowerCase())
      );
      
    } catch (error) {
      return false;
    }
  }

  async handleDynamicContent(page) {
    const maxIterations = 20;
    let iteration = 0;
    let previousJobCount = 0;
    let stableCount = 0;

    const jobListingSelectors = dictionaries.jobListingSelectors.slice(0, 15);
    
    while (iteration < maxIterations && stableCount < 3) {
      const currentJobCount = await page.evaluate((selectors) => {
        return document.querySelectorAll(selectors.join(', ')).length;
      }, jobListingSelectors);

      if (currentJobCount === previousJobCount) {
        stableCount++;
      } else {
        stableCount = 0;
        config.smartLog('platform', `Job count: ${currentJobCount}`);
      }

      const actionTaken = await this.tryExpandContent(page);
      if (!actionTaken) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(2000);
      }

      previousJobCount = currentJobCount;
      iteration++;
    }

    config.smartLog('platform', `Dynamic content handling complete: ${iteration} iterations`);
  }

  async tryExpandContent(page) {
    const showMoreSelectors = dictionaries.showMoreSelectors;
    const showMoreTextSelectors = dictionaries.showMoreTextSelectors;
    const paginationSelectors = dictionaries.paginationSelectors;
    
    let actionTaken = false;
    
    for (const selector of showMoreSelectors.slice(0, 15)) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          const text = await element.textContent();
          if (text && showMoreTextSelectors.some(pattern => 
            text.toLowerCase().includes(pattern.toLowerCase())
          )) {
            config.smartLog('platform', `Clicking show more: ${text.substring(0, 30)}`);
            await element.click();
            await page.waitForTimeout(3000);
            actionTaken = true;
            break;
          }
        }
      } catch (e) {}
    }
    
    if (!actionTaken) {
      for (const selector of paginationSelectors.slice(0, 10)) {
        try {
          const element = await page.$(selector);
          if (element && await element.isVisible()) {
            const text = await element.textContent();
            if (text && (text.toLowerCase().includes('next') || text.trim() === '>')) {
              config.smartLog('platform', `Clicking pagination: ${text.substring(0, 20)}`);
              await element.click();
              await page.waitForTimeout(4000);
              actionTaken = true;
              break;
            }
          }
        } catch (e) {}
      }
    }

    return actionTaken;
  }

  async extractUniversalJobContent(page, url, platformName) {
    try {
      const jobListingSelectors = dictionaries.jobListingSelectors;
      const jobURLPatterns = dictionaries.jobURLPatterns;
      const jobDetailURLPatterns = dictionaries.jobDetailURLPatterns;
      
      const result = await page.evaluate((selectors, urlPatterns, detailPatterns) => {
        const jobs = [];
        const seenUrls = new Set();
        
        for (const selector of selectors.slice(0, 25)) {
          try {
            const elements = document.querySelectorAll(selector);
            
            for (const element of elements) {
              const links = element.querySelectorAll('a');
              const directLink = element.tagName === 'A' ? element : null;
              
              const allLinks = directLink ? [directLink, ...links] : [...links];
              
              for (const link of allLinks) {
                if (!link.href || seenUrls.has(link.href)) continue;
                
                const href = link.href;
                const text = link.textContent?.trim() || '';
                
                if (text.length < 3 || text.length > 200) continue;
                
                const matchesJobPattern = urlPatterns.some(pattern => {
                  try {
                    return pattern.test(href);
                  } catch (e) {
                    return false;
                  }
                });
                
                const matchesDetailPattern = detailPatterns.some(pattern => {
                  try {
                    return pattern.test(href);
                  } catch (e) {
                    return false;
                  }
                });
                
                const hasJobKeywords = /job|career|position|opening|vacancy|emploi|poste|empleo|stelle|lavoro|praca|vaga|vacature|jobb|trabajo|arbeit|werk/i.test(text);
                
                const hasJobPath = /\/job[s]?\/|\/career[s]?\/|\/position[s]?\/|\/opening[s]?\/|\/vacanc/i.test(href);
                
                if (matchesJobPattern || matchesDetailPattern || hasJobKeywords || hasJobPath) {
                  seenUrls.add(href);
                  
                  const parent = link.closest('article, li, tr, div, section, [class*="job"], [class*="position"], [class*="career"]');
                  
                  let location = '';
                  let department = '';
                  let jobType = '';
                  
                  if (parent) {
                    const parentText = parent.textContent || '';
                    
                    const locationMatch = parentText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,?\s*[A-Z]{2,})|([A-Z][a-z]+,\s*[A-Z]{2,3})|(\b(?:Remote|Hybrid|On-site|Paris|London|Berlin|Madrid|Rome|Amsterdam|Stockholm|Oslo|Helsinki|Copenhagen|Dublin|Vienna|Prague|Warsaw|Budapest|Zurich|Geneva|Brussels|Luxembourg|Monaco|Lisbon|Barcelona|Milan|Munich|Hamburg|Frankfurt|Lyon|Marseille|Nice|Toulouse|Lille|Strasbourg|Nantes|Bordeaux|Montpellier|Rennes|Grenoble|Dijon|Angers|Brest|Le Mans|Tours|Orléans|Clermont-Ferrand|Limoges|Poitiers|La Rochelle|Angoulême|Périgueux|Agen|Auch|Tarbes|Pau|Bayonne|Dax|Mont-de-Marsan|Biarritz|Saint-Jean-de-Luz|Hendaye|Bidart|Anglet|Hossegor|Mimizan|Soustons|Capbreton|Labenne|Tarnos|Ondres|Saint-Vincent-de-Tyrosse|Saint-Paul-lès-Dax|Saint-Geours-de-Maremne|Magescq|Seignosse|Messanges|Vieux-Boucau-les-Bains|Léon|Linxe|Castets|Parentis-en-Born|Gastes|Sainte-Eulalie-en-Born|Ychoux|Moustey|Pissos|Solférino|Luxey|Labouheyre|Escource|Commensacq|Garein|Lüe|Trensacq|Sabres|Luglon|Arjuzanx|Retjons|Mont-de-Marsan|Villeneuve-de-Marsan|Benquet|Bougue|Campagne|Mazerolles|Gaillères|Saint-Pierre-du-Mont|Pouydesseaux|Laglorieuse|Saint-Avit|Geloux|Rion-des-Landes|Lucbardez-et-Bargues|Cauna|Serres-Gaston|Classun|Créon-d'Armagnac|Le Frêche|Arthez-d'Armagnac|Lannemaignan|Manciet|Perquie|Estang|Cazeneuve)\b)/gi);
                    location = locationMatch ? locationMatch[0].trim() : '';
                    
                    const deptMatch = parentText.match(/\b(?:Engineering|Sales|Marketing|HR|Finance|Operations|Product|Design|Support|R&D|Research|Development|IT|Technology|Customer|Legal|Admin|Business|Strategy|Communications|Creative|Data|Analytics|Security|Quality|Manufacturing|Production|Logistics|Supply|Chain|Procurement|Planning|Project|Program|Technical|Software|Hardware|Mobile|Web|Frontend|Backend|Fullstack|DevOps|Cloud|AI|Machine Learning|Data Science|UX|UI|QA|Testing|Leadership|Management|Executive|Director|Senior|Junior|Intern|Graduate|Entry|Mid|Lead|Principal|Staff|Architect|Specialist|Consultant|Analyst|Coordinator|Associate|Assistant|Representative|Administrator|Officer|Manager|Supervisor|Team Lead)\b/gi);
                    department = deptMatch ? deptMatch[0] : '';
                    
                    const typeMatch = parentText.match(/\b(?:Full-time|Part-time|Contract|Temporary|Freelance|Permanent|Internship|Remote|Hybrid|On-site|CDI|CDD|Stage|Alternance|Temps plein|Temps partiel|Intérim|Freelance|Télétravail|Présentiel|Hybride)\b/gi);
                    jobType = typeMatch ? typeMatch[0] : '';
                  }
                  
                  jobs.push({
                    title: text,
                    link: href,
                    location: location,
                    department: department,
                    jobType: jobType,
                    confidence: matchesJobPattern || matchesDetailPattern ? 0.9 : (hasJobKeywords ? 0.7 : 0.5)
                  });
                }
              }
            }
          } catch (e) {
          }
        }
        
        return {
          jobs: jobs.sort((a, b) => b.confidence - a.confidence),
          text: document.body.innerText,
          title: document.title
        };
      }, jobListingSelectors, jobURLPatterns, jobDetailURLPatterns);
      
      config.smartLog('platform', `Extracted ${result.jobs.length} jobs for ${platformName || 'unknown platform'}`);
      
      if (result.jobs.length === 0) {
        return null;
      }
      
      return {
        url,
        title: result.title || `${platformName || 'Universal'} Careers`,
        text: result.text,
        links: result.jobs.map(job => ({
          url: job.link,
          title: job.title,
          text: `${job.title}${job.location ? ' - ' + job.location : ''}${job.department ? ' (' + job.department + ')' : ''}${job.jobType ? ' [' + job.jobType + ']' : ''}`,
          isJobPosting: true,
          confidence: job.confidence,
          location: job.location,
          department: job.department,
          jobType: job.jobType
        })),
        scrapedAt: new Date().toISOString(),
        method: `platform-specific-${platformName ? platformName.toLowerCase() : 'universal'}`,
        jobCount: result.jobs.length,
        detectedPlatform: platformName
      };
      
    } catch (error) {
      config.smartLog('fail', `Content extraction failed: ${error.message}`);
      return null;
    }
  }

  async setupPage(page) {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ? 
        Promise.resolve({ state: 'prompt', onchange: null }) :
        originalQuery(parameters)
      );
    });
  }
}

module.exports = PlatformSpecificScrapers;