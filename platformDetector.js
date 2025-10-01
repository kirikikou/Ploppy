const dictionaries = require('../dictionaries');
const config = require('../config');

class PlatformDetector {
  static detectPlatform(url, html = '') {
    url = url.toLowerCase();
    html = html.toLowerCase();
    
    const priorityDomainCheck = this.detectPlatformByUrl(url);
    if (priorityDomainCheck) {
      config.smartLog('platform', `Priority domain detected: ${priorityDomainCheck}`);
      return priorityDomainCheck;
    }
    
    const textualDetection = this.detectPlatformByTextSearch(html);
    if (textualDetection) {
      config.smartLog('platform', `Detected ${textualDetection} via textual search`);
      return textualDetection;
    }
    
    const knownPlatforms = dictionaries.knownJobPlatforms;
    for (const platform of knownPlatforms) {
      for (const pattern of platform.patterns) {
        if (url.includes(pattern.toLowerCase())) {
          config.smartLog('platform', `Detected ${platform.name} from URL pattern: ${pattern}`);
          return platform.name;
        }
      }
    }
    
    if (html) {
      for (const platform of knownPlatforms) {
        if (platform.indicators) {
          let indicatorMatches = 0;
          let totalIndicators = platform.indicators.length;
          
          for (const indicator of platform.indicators) {
            if (html.includes(indicator.toLowerCase())) {
              indicatorMatches++;
              
              if (platform.name === 'Workable') {
                const workableSpecificIndicators = [
                  'data-testid="job-card"',
                  'workable-jobs',
                  'workable-application',
                  'careers-page.workable.com',
                  'wk-',
                  'workable-shortlist'
                ];
                
                const hasSpecificIndicator = workableSpecificIndicators.some(specific => 
                  html.includes(specific.toLowerCase())
                );
                
                if (hasSpecificIndicator || indicatorMatches >= 2) {
                  config.smartLog('platform', `Detected ${platform.name} from specific HTML indicator: ${indicator}`);
                  return platform.name;
                }
              } else if (platform.name === 'Recruitee') {
                const recruiteeSpecificIndicators = [
                  'recruitee-careers-widget',
                  'recruitee-job-list', 
                  'recruitee-offers',
                  'data-recruitee',
                  'rt-widget',
                  'rt-job-list'
                ];
                
                const hasSpecificIndicator = recruiteeSpecificIndicators.some(specific => 
                  html.includes(specific.toLowerCase())
                );
                
                if (hasSpecificIndicator) {
                  config.smartLog('platform', `Detected ${platform.name} from specific HTML indicator: ${indicator}`);
                  return platform.name;
                }
              } else if (platform.name === 'Smartrecruiters') {
                const smartRecruitersSpecificIndicators = [
                  'smartrecruiters-widget',
                  'sr-job-board',
                  'smartrecruiters.com/embed',
                  'smartrecruiters attrax',
                  'attrax.co.uk',
                  'smartattrax',
                  'sr-job',
                  'sr-apply'
                ];
                
                const hasSpecificIndicator = smartRecruitersSpecificIndicators.some(specific => 
                  html.includes(specific.toLowerCase())
                );
                
                if (hasSpecificIndicator || indicatorMatches >= 1) {
                  config.smartLog('platform', `Detected ${platform.name} from specific HTML indicator: ${indicator}`);
                  return platform.name;
                }
              } else if (platform.name === 'iCIMS') {
                const icimsSpecificIndicators = [
                  'icims-jobs',
                  'icims-content-container',
                  'icims-portal',
                  'icims-content',
                  'powered by icims',
                  'icims.com',
                  'careers.icims.com',
                  'icims_content_iframe',
                  'careers-home',
                  'in_iframe=1'
                ];
                
                const hasSpecificIndicator = icimsSpecificIndicators.some(specific => 
                  html.includes(specific.toLowerCase())
                );
                
                if (hasSpecificIndicator || indicatorMatches >= 1) {
                  config.smartLog('platform', `Detected ${platform.name} from specific HTML indicator: ${indicator}`);
                  return platform.name;
                }
              } else {
                config.smartLog('platform', `Detected ${platform.name} from HTML indicator: ${indicator}`);
                return platform.name;
              }
            }
          }
          
          if (platform.name === 'Recruitee' && indicatorMatches >= 2) {
            config.smartLog('platform', `Detected ${platform.name} from multiple indicators: ${indicatorMatches}/${totalIndicators}`);
            return platform.name;
          }
        }
        
        if (html && platform.apiPatterns) {
          for (const apiPattern of platform.apiPatterns) {
            if (html.includes(apiPattern.toLowerCase())) {
              config.smartLog('platform', `Detected ${platform.name} from API pattern: ${apiPattern}`);
              return platform.name;
            }
          }
        }
      }
    }
    
    const complexDomains = dictionaries.complexDomains;
    const complexDomainMatch = complexDomains.find(domain => url.includes(domain.toLowerCase()));
    if (complexDomainMatch) {
      config.smartLog('platform', `Detected complex domain: ${complexDomainMatch}`);
      return `Complex Domain (${complexDomainMatch})`;
    }
    
    const urlIndicators = [
      { pattern: /careers?\./, name: 'Career Site' },
      { pattern: /jobs?\./, name: 'Job Board' },
      { pattern: /recruit/, name: 'Recruitment Platform' },
      { pattern: /hiring/, name: 'Hiring Platform' },
      { pattern: /talent/, name: 'Talent Platform' },
      { pattern: /apply\./, name: 'Application Portal' }
    ];
    
    for (const indicator of urlIndicators) {
      if (indicator.pattern.test(url)) {
        config.smartLog('platform', `Detected generic ${indicator.name}`);
        return indicator.name;
      }
    }
    
    return null;
  }
  
  static detectPlatformByUrl(url) {
    const priorityPatterns = {
      'Greenhouse': [
        'greenhouse.io',
        'job-boards.greenhouse.io',
        'boards.greenhouse.io'
      ],
      'Workday': [
        'myworkdayjobs.com',
        'workdayjobs.com'
      ],
      'Lever': [
        'jobs.lever.co'
      ],
      'Workable': [
        'apply.workable.com',
        'careers-page.workable.com',
        'jobs.workable.com'
      ],
      'TeamTailor': [
        'career.teamtailor.com'
      ],
      'Recruitee': [
        'recruitee.com'
      ],
      'Jobvite': [
        'jobvite.com',
        'jobs.jobvite.com'
      ],
      'iCIMS': [
        'icims.com',
        'careers.icims.com',
        'jobs.icims.com'
      ],
      'BambooHR': [
        'bamboohr.com'
      ],
      'Smartrecruiters': [
        'smartrecruiters.com',
        'jobs.smartrecruiters.com'
      ],
      'JazzHR': [
        'applytojob.com',
        'jazzhr.com'
      ],
      'ZohoRecruit': [
        'zohorecruit.com',
        'recruit.zoho.com'
      ],
      'Brassring': [
        'brassring.com',
        'kenexa.brassring.com',
        'ibm.brassring.com'
      ],
      'ADP': [
        'workforcenow.adp.com',
        'recruiting.adp.com',
        'jobs.adp.com'
      ]
    };
    
    for (const [platform, patterns] of Object.entries(priorityPatterns)) {
      for (const pattern of patterns) {
        if (url.includes(pattern.toLowerCase())) {
          return platform;
        }
      }
    }
    
    return null;
  }
  
  static detectPlatformByTextSearch(html) {
    if (!html) return null;
    
    const textualPatterns = {
      'JazzHR': [
        'applytojob.com',
        'jazzhr.com',
        'jazz-jobs',
        'google-hire',
        'jazzhr-widget',
        'jazz-apply',
        'jazz-career',
        'job-application-form',
        'jazz-job-board',
        'application-widget',
        'apply to job',
        'powered by jazzhr',
        '/apply/jobs',
        '/widget/jobs',
        '/public/jobs',
        'hire.withgoogle.com'
      ],
      'ADP': [
        'workforcenow.adp.com',
        'recruiting.adp.com', 
        'jobs.adp.com',
        'adp.com/jobs',
        'adp.com/careers',
        '/mascsr',
        '/selfservice',
        'adp-jobs',
        'adp-recruiting',
        'wfn-jobs',
        'adp-workforce',
        'adp-portal',
        'adp-application',
        'workforce now',
        'adp workforce',
        'workforcenow',
        'workforce-now',
        'adp-careers',
        'adp-job-board',
        'adp-recruitment',
        'adp-hiring',
        'adp-postings',
        'adp-talent',
        'adp-hr',
        'mascsr/default/mdf/recruitment',
        'selectedMenuKey=CareerCenter',
        'selectedMenuKey=CurrentOpenings',
        'cxs.adp.com',
        'adp-embed',
        'adp-iframe',
        'powered by adp',
        'adp workforcenow',
        'adp.com/en/jobs'
      ],
      'ZohoRecruit': [
        'zohorecruit.com',
        'recruit.zoho.com',
        'recruit.zoho.eu',
        'recruit.zoho.in',
        'zohorecruit',
        'zohocorp',
        'zoho-recruit',
        'zoho_recruit',
        'zr-job-list',
        'zr-job-item',
        'zoho-careers',
        'zr-apply',
        'zoho-job-board',
        'zrwidget',
        'zohoform',
        'zoho-form',
        'zr-postings',
        'recruit-postings',
        'zoho-application',
        'zr-career-site',
        'powered by zoho recruit',
        'zoho recruit',
        'zr-iframe',
        'zohoRecruit',
        'ZohoRecruit'
      ],
      'Smartrecruiters': [
        'jobs.smartrecruiters.com',
        'smartrecruiters-widget',
        'sr-job-board',
        'smartrecruiters.com/embed',
        'smartrecruiters attrax',
        'smartrecruiters attrax',
        'attrax.co.uk',
        'smartattrax',
        'sr-job',
        'sr-apply',
        'smartrecruiters-careers',
        'powered by smartrecruiters',
        'smartrecruiters-jobs',
        'smartrecruiters.com',
        'careers.smartrecruiters.com',
        'smartrecruiterscareers.com'
      ],
      'Workable': [
        'apply.workable.com',
        'careers-page.workable.com',
        'workable.com/careers',
        'workable-application',
        'workable-jobs',
        'workable-widget',
        'data-testid="job-card"',
        'wk-',
        'workable-shortlist',
        'jobs.workable.com',
        '/api/v1/jobs',
        '/api/v2/jobs',
        'workable-careers-iframe'
      ],
      'Lever': [
        'jobs.lever.co',
        'lever-application',
        'lever-postings',
        'lever-careers',
        'jobs powered by',
        'lever.co/job-seeker-support',
        '/_postings',
        '/v0/postings',
        '/v1/postings',
        'lever-jobs'
      ],
      'Powershift': [
        'powered by powershift',
        'powershift.co.uk',
        'powershift-main.js',
        'powershift.js',
        'powershift-scripts',
        'powershift-styles'
      ],
      'TeamTailor': [
        'career.teamtailor.com',
        'teamtailor.com/js',
        'teamtailor-widget',
        'tt-career-page',
        'teamtailor-careers'
      ],
      'Greenhouse': [
        'boards.greenhouse.io',
        'job-boards.greenhouse.io',
        'greenhouse.io',
        'greenhouse-board',
        'greenhouse.io/embed',
        'greenhouse-application',
        'gh-job-board',
        'greenhouse-jobs',
        'greenhouse-widget',
        'greenhouse-posting',
        'gh-',
        'greenhouse-iframe'
      ],
      'Workday': [
        'myworkdayjobs.com',
        'workday.com/wday',
        'workday-application',
        'wday/cxs',
        'workdayjobs'
      ],
      'BambooHR': [
        'bamboohr.com/jobs/embed',
        'bamboohr.com/careers',
        '.bamboohr.com/jobs/',
        'bamboohr-ats-jobs',
        'bamboo-datafeed'
      ],
      'Recruitee': [
        'recruitee.com/embed',
        'd10zminp1cyta8.cloudfront.net',
        'recruitee-careers-widget',
        'rt-widget',
        'recruitee-embed'
      ],
      'Jobvite': [
        'jobvite.com/companyJobs',
        'jobs.jobvite.com',
        'jv-careersite',
        'jobvite-careers-iframe',
        'jv-job-list'
      ],
      'iCIMS': [
        'jobs.icims.com',
        'careers.icims.com', 
        'careers-audacy.icims.com',
        'icims-portal',
        'icims-content',
        'icims-jobs',
        'icims-widget',
        'icims-career',
        'icims-search',
        'icims-job-list',
        'icims-posting',
        'icims-application',
        'icims_content_iframe',
        'icims_handlepostmessage',
        'powered by icims',
        'icims.com/jobs',
        'icims-embed',
        'icims-iframe',
        'icims-board',
        'icims-content-container',
        '/jobs/search',
        '/careers-home/jobs',
        '/jobs/candidates',
        'careers-home',
        'icims.com',
        'in_iframe=1',
        'noscript_icims_content_iframe',
        'icims_iframe_span',
        'iCIMS_JobsTable',
        'iCIMS_Table',
        'iCIMS_JobListingRow',
        'iCIMS_JobContainer',
        'iCIMS_MainWrapper',
        'icimsJobs',
        'icims-requisition',
        'icims-candidates',
        'icims-external-api'
      ],
      'Taleo': [
        'taleo.net/careersection',
        'tbe.taleo.net',
        'taleo-careersection',
        'taleo-jobs'
      ],
      'Ashby': [
        'jobs.ashbyhq.com',
        'ashby-job-board',
        'ashbyhq.com/api',
        'ashby-application'
      ],
      'Personio': [
        'jobs.personio.de',
        'personio-position',
        'personio.com/xml',
        'personio-widget'
      ],
      'WordPress': [
        'wp-content/themes',
        'wp-includes/js',
        'wordpress.org',
        'wp-json/wp',
        'wp-content/plugins',
        'wp-admin',
        'wp-login',
        'wp-embed',
        '/wp/',
        'wp_'
      ],
      'Drupal': [
        'drupal.org',
        'sites/default/files',
        'drupal-settings',
        'drupal.js'
      ],
      'Shopify': [
        'shopify.com',
        'shopify-section',
        'shopifycdn.com',
        'shopify-analytics'
      ],
      'Brassring': [
        'brassring.com',
        'kenexa.brassring.com',
        'ibm.brassring.com',
        'sjobs.brassring.com',
        'jobs.brassring.com',
        '/TGnewUI/',
        '/TGWebHost/',
        '/TgNewUI/',
        'tgwebhost',
        'tgnewui',
        'partnerid=',
        'siteid=',
        'jobdetails.aspx',
        'searchresults.aspx',
        'TGWebHost/home.aspx',
        'TGWebHost/jobdetails',
        'JOB_ID=',
        'powered by brassring',
        'brassring talent gateway',
        'talent gateway',
        'kenexa',
        'brassring-jobs',
        'brassring-gateway',
        '/TGWebService/',
        'searchResultsItem',
        'jobResultItem'
      ],
    };
    
    for (const [platform, patterns] of Object.entries(textualPatterns)) {
      let matchCount = 0;
      const foundPatterns = [];
      
      for (const pattern of patterns) {
        if (html.includes(pattern.toLowerCase())) {
          matchCount++;
          foundPatterns.push(pattern);
          
          const strongIndicators = [
            'icims-portal',
            'icims-content-container',
            'icims_content_iframe',
            'powered by icims',
            'icims.com/jobs',
            '/jobs/search',
            '/careers-home/jobs',
            'careers.icims.com',
            'jobs.icims.com',
            'in_iframe=1',
            'noscript_icims_content_iframe',
            'zohorecruit.com',
            'recruit.zoho.com',
            'powered by zoho recruit',
            'zoho recruit',
            'zr-job-list',
            'zoho-careers',
            'zr-job-item',
            'zr-apply',
            'zoho-job-board',
            'zrwidget',
            'zohoform',
            'zoho-form',
            'zr-postings',
            'recruit-postings',
            'zoho-application',
            'zr-career-site',
            'jobs.lever.co',
            'bamboohr.com/jobs/embed',
            'boards.greenhouse.io',
            'job-boards.greenhouse.io',
            'greenhouse.io',
            'myworkdayjobs.com',
            'powered by powershift',
            'career.teamtailor.com',
            'jobs powered by',
            'apply.workable.com',
            'careers-page.workable.com',
            'data-testid="job-card"',
            'jobs.smartrecruiters.com',
            'smartrecruiters attrax',
            'attrax.co.uk',
            'smartattrax',
            'smartrecruiters-widget',
            'applytojob.com',
            'jazzhr.com',
            'jazz-jobs',
            'jazz-job-board',
            'powered by jazzhr',
            'brassring.com',
            'kenexa.brassring.com',
            'ibm.brassring.com',
            '/TGnewUI/',
            '/TGWebHost/',
            'powered by brassring',
            'brassring-jobs',
            'kenexa',
            'wp-content/themes',
            'wp-includes/js',
            'wp-json/wp',
            'wp-content/plugins'
          ];
          
          if (strongIndicators.includes(pattern.toLowerCase())) {
            config.smartLog('platform', `Strong textual match for ${platform}: ${pattern}`);
            return platform;
          }
        }
      }
      
      if ((platform === 'iCIMS') && matchCount >= 1) {
        config.smartLog('platform', `${platform} detected with patterns: ${foundPatterns.join(', ')}`);
        return platform;
      }

      if ((platform === 'Smartrecruiters' || platform === 'JazzHR' || platform === 'iCIMS') && matchCount >= 1) {
        config.smartLog('platform', `${platform} detected with patterns: ${foundPatterns.join(', ')}`);
        return platform;
      }
      
      if ((platform === 'ZohoRecruit' || platform === 'Smartrecruiters' || platform === 'JazzHR' || platform === 'iCIMS') && matchCount >= 1) {
        config.smartLog('platform', `${platform} detected with patterns: ${foundPatterns.join(', ')}`);
        return platform;
      }

      if ((platform === 'Brassring' || platform === 'iCIMS') && matchCount >= 1) {
        config.smartLog('platform', `${platform} detected with patterns: ${foundPatterns.join(', ')}`);
        return platform;
      }

      if (matchCount >= 2) {
        config.smartLog('platform', `Multiple textual matches for ${platform}: ${foundPatterns.join(', ')}`);
        return platform;
      }
      
      if (matchCount >= 1 && ['WordPress', 'Drupal', 'Shopify', 'Workable', 'JazzHR', 'iCIMS'].includes(platform)) {
        config.smartLog('platform', `CMS/Platform detected: ${platform} (${foundPatterns[0]})`);
        return platform;
      }
    }
    
    return null;
  }
  
  static shouldBlockStep(detectedPlatform, stepName) {
    if (!detectedPlatform) return false;
    
    const platformBlocking = {
      'ZohoRecruit': ['bamboohr-step', 'recruitee-step', 'workable-step', 'lever-step', 'greenhouse-step', 'smartrecruiters-step', 'jazzhr-step', 'powershift-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'JazzHR': ['bamboohr-step', 'recruitee-step', 'workable-step', 'lever-step', 'greenhouse-step', 'smartrecruiters-step', 'powershift-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Workable': ['bamboohr-step', 'recruitee-step', 'jobvite-step', 'greenhouse-step', 'lever-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Lever': ['bamboohr-step', 'recruitee-step', 'jobvite-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Powershift': ['bamboohr-step', 'recruitee-step', 'jobvite-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'WordPress': ['bamboohr-step', 'recruitee-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step'],
      'TeamTailor': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Greenhouse': ['bamboohr-step', 'recruitee-step', 'lever-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'brassring-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Workday': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Smartrecruiters': ['bamboohr-step', 'recruitee-step', 'workable-step', 'lever-step', 'greenhouse-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'iCIMS': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'lever-step', 'powershift-step', 'zoho-recruit-step', 'zoho-recruit-headless-step', 'workday-step', 'brassring-step', 'adp-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Taleo': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Ashby': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Personio': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Jobvite': ['recruitee-step', 'lightweight-variants', 'bamboohr-step', 'greenhouse-step', 'workable-step', 'headless-rendering', 'powershift-step', 'smartrecruiters-step', 'jazzhr-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Brassring': ['bamboohr-step', 'recruitee-step', 'workable-step', 'lever-step', 'greenhouse-step', 'smartrecruiters-step', 'jazzhr-step', 'powershift-step', 'zoho-recruit-step', 'zoho-recruit-headless-step', 'workday-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'Workday': ['bamboohr-step', 'recruitee-step', 'greenhouse-step', 'workable-step', 'smartrecruiters-step', 'jazzhr-step', 'brassring-step', 'zoho-recruit-step', 'powershift-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
      'ADP': ['bamboohr-step', 'recruitee-step', 'workable-step', 'lever-step', 'greenhouse-step', 'smartrecruiters-step', 'jazzhr-step', 'powershift-step', 'zoho-recruit-step', 'zoho-recruit-headless-step', 'icims-step', 'wordpress-lightweight', 'wordpress-headless', 'wordpress-iframe'],
    };
    
    const blockedSteps = platformBlocking[detectedPlatform] || [];
    const shouldBlock = blockedSteps.includes(stepName);
    
    if (shouldBlock) {
      config.smartLog('platform', `Blocking ${stepName} because ${detectedPlatform} was detected`);
    }
    
    return shouldBlock;
  }
  
  static getRecommendedStep(detectedPlatform) {
    const platformSteps = {
      'ZohoRecruit': 'zoho-recruit-step',
      'JazzHR': 'jazzhr-step',
      'Workable': 'workable-step',
      'Lever': 'lever-step',
      'BambooHR': 'bamboohr-step',
      'Recruitee': 'recruitee-step',
      'Jobvite': 'iframe-aware-rendering',
      'Greenhouse': 'greenhouse-step',
      'TeamTailor': 'teamtailor-step',
      'Smartrecruiters': 'smartrecruiters-step',
      'iCIMS': 'icims-step',
      'Taleo': 'headless-rendering',
      'Ashby': 'lightweight-variants',
      'Personio': 'lightweight-variants',
      'Powershift': 'powershift-step',
      'WordPress': 'wordpress-lightweight',
      'Brassring': 'brassring-step',
      'Workday': 'workday-step',
      'ADP': 'adp-step',  
    };
    
    return platformSteps[detectedPlatform] || null;
  }
  
  static getPlatformConfig(platformName) {
    const platforms = dictionaries.knownJobPlatforms;
    const platform = platforms.find(p => p.name === platformName);
    if (!platform) return null;
    
    return {
      name: platform.name,
      useIframe: platform.iframeMethod || false,
      directMethod: platform.directMethod || false,
      apiPatterns: platform.apiPatterns || [],
      indicators: platform.indicators || []
    };
  }
  
  static isKnownJobPlatform(url) {
    const platform = this.detectPlatform(url);
    return platform !== null;
  }
  
  static requiresSpecialHandling(platformName) {
    const specialHandlingPlatforms = [
      'Jobvite', 'Workday', 'Taleo', 'BambooHR', 'Brassring', 'ADP', 'Lever', 'Workable', 'Smartrecruiters', 'ZohoRecruit', 'iCIMS', 'WordPress'
    ];
    return specialHandlingPlatforms.includes(platformName);
  }
  
  static isComplexDomain(url) {
    url = url.toLowerCase();
    const complexDomains = dictionaries.complexDomains;
    return complexDomains.some(domain => url.includes(domain.toLowerCase()));
  }
  
  static containsJobTerms(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    const jobTerms = dictionaries.jobTerms;
    return jobTerms.some(term => lowerText.includes(term.toLowerCase()));
  }
  
  static detectJobContent(html) {
    if (!html) return { hasJobContent: false, confidence: 0 };
    
    const lowerHtml = html.toLowerCase();
    let jobTermCount = 0;
    const foundTerms = [];
    const jobTerms = dictionaries.jobTerms;
    
    for (const term of jobTerms) {
      const regex = new RegExp(`\\b${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = lowerHtml.match(regex);
      if (matches) {
        jobTermCount += matches.length;
        foundTerms.push(term);
      }
    }
    
    const confidence = Math.min(jobTermCount / 10, 1);
    
    return {
      hasJobContent: jobTermCount > 0,
      confidence: confidence,
      termCount: jobTermCount,
      foundTerms: foundTerms.slice(0, 10)
    };
  }
  
  static detectDynamicContent(html) {
    if (!html) return false;
    
    const lowerHtml = html.toLowerCase();
    const dynamicIndicators = dictionaries.dynamicContentIndicators;
    return dynamicIndicators.some(indicator => {
      const selector = indicator.replace(/\[|\]|:/g, '').toLowerCase();
      return lowerHtml.includes(selector);
    });
  }
  
  static hasShowMoreButtons(html) {
    if (!html) return false;
    
    const lowerHtml = html.toLowerCase();
    const showMoreSelectors = dictionaries.showMoreSelectors;
    const showMorePatterns = dictionaries.showMorePatterns;
    
    return showMoreSelectors.some(selector => {
      const cleanSelector = selector.replace(/[\[\]\.#:(),>+~*]/g, '').toLowerCase();
      return cleanSelector && lowerHtml.includes(cleanSelector);
    }) || showMorePatterns.regex.test(html);
  }
  
  static hasPagination(html) {
    if (!html) return false;
    
    const lowerHtml = html.toLowerCase();
    const paginationSelectors = dictionaries.paginationSelectors;
    const paginationPatterns = dictionaries.paginationPatterns;
    
    return paginationSelectors.some(selector => {
      const cleanSelector = selector.replace(/[\[\]\.#:(),>+~*]/g, '').toLowerCase();
      return cleanSelector && lowerHtml.includes(cleanSelector);
    }) || paginationPatterns.regex.test(html);
  }
  
  static detectJobListings(html) {
    if (!html) return { hasListings: false, count: 0 };
    
    const lowerHtml = html.toLowerCase();
    let listingCount = 0;
    const jobListingSelectors = dictionaries.jobListingSelectors;
    
    for (const selector of jobListingSelectors) {
      const cleanSelector = selector.replace(/[\[\]\.#:(),>+~*]/g, '').toLowerCase();
      if (cleanSelector) {
        const regex = new RegExp(cleanSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matches = lowerHtml.match(regex);
        if (matches) {
          listingCount += matches.length;
        }
      }
    }
    
    return {
      hasListings: listingCount > 0,
      count: Math.min(listingCount, 100)
    };
  }
  
  static analyzePageStructure(url, html) {
    const platform = this.detectPlatform(url, html);
    const jobContent = this.detectJobContent(html);
    const dynamicContent = this.detectDynamicContent(html);
    const showMore = this.hasShowMoreButtons(html);
    const pagination = this.hasPagination(html);
    const listings = this.detectJobListings(html);
    const isComplex = this.isComplexDomain(url);
    
    return {
      platform: platform,
      isComplex: isComplex,
      jobContent: jobContent,
      hasDynamicContent: dynamicContent,
      hasShowMore: showMore,
      hasPagination: pagination,
      listings: listings,
      scrapingStrategy: this.getRecommendedStrategy(platform, isComplex, dynamicContent, showMore, pagination),
      recommendedStep: this.getRecommendedStep(platform)
    };
  }
  
  static getRecommendedStrategy(platform, isComplex, hasDynamic, hasShowMore, hasPagination) {
    if (platform && this.requiresSpecialHandling(platform)) {
      return 'specialized_scraper';
    }
    
    if (hasDynamic || hasShowMore || hasPagination) {
      return 'headless_browser';
    }
    
    if (isComplex) {
      return 'progressive_scraper';
    }
    
    return 'simple_http';
  }
}

module.exports = PlatformDetector;