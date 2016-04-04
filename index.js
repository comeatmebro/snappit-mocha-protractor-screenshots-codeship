'use strict';

let path = require('path');

let _ = require('lodash');
let chalk = require('chalk');
let fs = require('fs-extra');
let lwip = require('lwip');
let resemble = require('node-resemble');
let zfill = _.partialRight(_.padStart, '0');

module.exports.logWarnings = true;
module.exports.threshold = 4; // percent
module.exports.defaultResolutions = [];
module.exports.disable = false;

let noScreenshot = (element, reason, fileName) => {
    if (module.exports.logWarnings) {
        console.log('Error: element', element.locator().toString(), reason, 'No screenshot taken.');
    }
};

let fileSystemFriendly = fileName => {
    return fileName.replace(/([!.,+?<>:*|"])/g, '').replace(/\s+/g, '-');
};

let buildFullNameFromParents = (testInformation, acc) => {
    if (acc === undefined) {
        acc = [];
    }
    if (testInformation.parent) {
        acc.push(testInformation.parent.title);
        return buildFullNameFromParents(testInformation.parent, acc);
    } else {
        acc.pop();
        return acc.reverse().join(' ');
    }
};

// catch odd cases around `before`, `after`, etc.
let handleMochaHooks = testContext => {
    let fullTitle;
    let file;
    let testInformation = testContext.test || testContext.currentTest;
    if (testContext.test.type === 'hook') {
        fullTitle = `${buildFullNameFromParents(testInformation)}-${testInformation.title}`;
        file = testInformation.parent.file;
    } else {
        fullTitle = testInformation.fullTitle();
        file = testInformation.file;
    }
    return {
        fullTitle: fullTitle,
        file: file
    };
};

let getScreenshotNameFromContext = testContext => {
    return browser.getCapabilities().then(capabilities => {
        return browser.driver.manage().window().getSize().then(resolution => {
            let resolutionString = `${zfill(resolution.width, 4)}x${zfill(resolution.height, 4)}`;
            let browserName = capabilities.caps_.browserName;
            let screenshotDir = path.join('screenshots', browserName);
            let test = handleMochaHooks(testContext);
            let fullyQualifiedPath = test.file.split('/');
            let commonPath = _.takeWhile(path.resolve(__dirname).split('/'), (directoryPart, index) => {
                return directoryPart === fullyQualifiedPath[index];
            }).join('/');
            let relativeFilePath = fullyQualifiedPath.join('/').replace(commonPath, '');
            let cleanPathName = relativeFilePath.replace(/\.js$/, '').replace(/\./g, '-');
            let rawName = path.join(screenshotDir, cleanPathName, test.fullTitle, resolutionString);
            return fileSystemFriendly(rawName);
        });
    });
};

let writeImage = (image, screenshotName, deferred) => {
    let flow = browser.controlFlow();
    let writeFileFn = () => {
        fs.mkdirsSync(path.dirname(screenshotName));
        image.writeFile(screenshotName, err => {
            if (err) {
                console.log('Error saving screenshot:', err);
                return deferred.reject();
            }
            return deferred.fulfill();
        });
    };
    flow.execute(writeFileFn);
};

// compares the image before saving it, using `threshold` setting as a gate.
let saveImage = (image, screenshotName, deferred, options) => {
    let flow = browser.controlFlow();
    if (fs.existsSync(screenshotName)) {
        let toBufferFn = () => {
            image.toBuffer('png', { compression: 'none' }, (err, imageBuffer) => {
                if (err) {
                    console.log('Error creating comparison image buffer', err);
                    deferred.reject();
                }
                let comparisonFn = () => {
                    let comparison = resemble(imageBuffer).compareTo(screenshotName);
                    comparison.onComplete(data => {
                        if (parseFloat(data.misMatchPercentage) > options.threshold) {
                            if (module.exports.logWarnings) {
                                let percentage = chalk.yellow.bold(data.misMatchPercentage + '%');
                                let shortName = chalk.red(path.basename(screenshotName));
                                console.log('%s difference in screenshot %s', percentage, shortName);
                            }
                            return writeImage(image, screenshotName, deferred);
                        }
                        return deferred.fulfill();
                    });
                };
                flow.execute(comparisonFn);
            });
        };
        flow.execute(toBufferFn);
    } else {
        if (module.exports.logWarnings) {
            let newMessage = chalk.green.bold('New screenshot added:');
            let shortName = chalk.red(path.basename(screenshotName));
            console.log('%s %s', newMessage, shortName);
        }
        return writeImage(image, screenshotName, deferred);
    }
};

let cropAndSaveImage = (image, elem, imageName, deferred, options) => {
    return elem.isPresent().then(present => {
        if (present) {
            let info = [elem.isDisplayed(), elem.getSize(), elem.getLocation()];
            return protractor.promise.all(info).then(info => {
                let displayed = info[0];
                let size = info[1];
                let location = info[2];
                image.crop(
                    location.x, // left
                    location.y, // top
                    location.x + size.width, // right
                    location.y + size.height, // bottom
                    (err, image) => {
                        if (err) {
                            console.log('Error', err);
                            return deferred.reject();
                        }
                        if (!displayed) {
                            // cropped to zero means deleted entirely, with warning
                            noScreenshot(elem, 'not displayed.', imageName);
                            return deferred.reject();
                        }
                        return saveImage(image, imageName, deferred, options);
                    }
                );
            });
        }  else {
            noScreenshot(elem, 'not present.', imageName);
            return deferred.reject();
        }
    });
};

// [[111, 222], [222, 333], [111, 222]] -> [[111, 222], [222, 333]]
// This exists in case you pass in a resolution that is already in module.exports.defaultResolutions
let uniqueResolutions = (resolutions, ignoreDefaultResolutions) => {
    if (resolutions === undefined) {
        resolutions = [];
    }

    let allResolutions = resolutions;
    if (ignoreDefaultResolutions === false) {
        allResolutions = resolutions.concat(module.exports.defaultResolutions);
    }

    return _.uniq(allResolutions, resolution => {
        return resolution.join(' ');
    });
};

let snapOne = (testContext, elem, options) => {
    let flow = browser.controlFlow();
    let snapFn = () => {
        return getScreenshotNameFromContext(testContext).then(screenshotName => {
            return browser.takeScreenshot().then(screenshotData => {
                let deferred = protractor.promise.defer();
                lwip.open(new Buffer(screenshotData, 'base64'), 'png', (err, image) => {
                    if (err) {
                        console.log('Error opening screenshot:', err);
                        return deferred.reject();
                    }
                    if (elem === undefined) {
                        // without an `elem` to crop to, rename the file to be the full screenshot
                        let fullScreenName = screenshotName + '-full-screen.png';
                        return saveImage(image, fullScreenName, deferred, options);
                    } else {
                        let croppedName = `${screenshotName}-${elem.locator().toString()}.png`;
                        return cropAndSaveImage(image, elem, croppedName, deferred, options);
                    }
                });
                return deferred.promise;
            });
        });
    };
    return flow.execute(snapFn);
};

/**
 * Calling this function with no `elem` will take a screenshot of the entire browser window.
 * @param {Object} testContext - The `this` object from the current mocha test.
 * @param {ElementFinder} [elem=] - Crop screenshot to contain just `elem`. If undefined, snap entire browser screen.
 * @param {Array<Array<Number>>} resolutions - List of two-part arrays containing browser resolutions to snap.
 * @param {Object} config - Options to be used for just this call.
 * @param {Boolean} config.ignoreDefaultResolutions - Ignore using default resolutions for just one call.
 * @returns {undefined}
 */
exports.snap = (testContext, elem, options) => {
    if (module.exports.disable) {
        return;
    }

    if (options === undefined) {
        options = {};
    }

    options = _.defaults(options, {
        resolutions: [],
        ignoreDefaultResolutions: false,
        threshold: module.exports.threshold
    });

    let flow = browser.controlFlow();
    let allResolutions = uniqueResolutions(options.resolutions, options.ignoreDefaultResolutions);
    if (allResolutions.length) {
        return browser.driver.manage().window().getSize().then(originalResolution => {
            let originalWidth = originalResolution.width;
            let originalHeight = originalResolution.height;
            _.forEach(allResolutions, resolution => {
                let takeEachScreenshotFn = () => {
                    let width = resolution[0];
                    let height = resolution[1];
                    browser.driver.manage().window().setSize(width, height);
                    snapOne(testContext, elem, options);
                };
                return flow.execute(takeEachScreenshotFn);
            });
            browser.driver.manage().window().setSize(originalWidth, originalHeight);
            snapOne(testContext, elem, options);
        });
    } else {
        snapOne(testContext, elem, options);
    }
};

exports.configure = options => {
    _.forEach(options, (value, key) => {
        module.exports[key] = value;
    });
};
