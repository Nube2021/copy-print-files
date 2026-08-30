// Downloads the skus from the unprocessed orders and copies the respective print 
// files to a specified folder
// TO GENERATE AN EXECUTABLE, type "pkg copy-print-files.js" in this directory

// TEST MODE: Set to true to skip stock checking and prevent stock list modifications
const TEST_MODE = true;

// const sharp = require('sharp')
// const $ = require('jquery')
const fs = require('fs')
const fsPromises = require('fs').promises;
const https = require('https');
const readline = require('readline');
// var path = require('path');

const exceptionSkusFromMissing = ['posterframe', 'posterhanger', 'framing_service'];
const problematicMotifIds = ['16095', '16092', '16086', '16085', '16084', '15421', '16090'];
var hundredSeventyCounter = 0;
var total100x70 = 0; // Total count of 100x70 files from server
var total120x80 = 0; // Total count of 120x80 files from server
var copied100x70LongerEdge = 0; // Counter for copied 100x70 longer edge files
var copied120x80LongerEdge = 0; // Counter for copied 120x80 longer edge files
var target100x70LongerEdge = 0; // User-defined limit for 100x70 longer edge
var target120x80LongerEdge = 0; // User-defined limit for 120x80 longer edge
var numSkus = 0;
// Keep a running destination filename counter per SKU+part+sizeDir to avoid overwriting
// when the same print file appears across multiple orders.
const nextCopyIndex = new Map();

// File cache: maps filename (without path) to full path for instant lookups
const fileCache = new Map(); // For all print files (including -le files)

// Build file cache from source directories
async function buildFileCache(directories, cacheMap, label) {
    console.log(`Building ${label} file cache from source directories...`);
    const startTime = Date.now();
    
    for (const dir of directories) {
        if (!fs.existsSync(dir)) continue;
        
        try {
            const files = await fsPromises.readdir(dir);
            for (const file of files) {
                if (file.endsWith('.jpg')) {
                    const fullPath = dir + '/' + file;
                    // Store with filename as key for quick lookup
                    cacheMap.set(file, fullPath);
                }
            }
        } catch (err) {
            console.log(`Warning: Could not read directory ${dir}`);
        }
    }
    
    const elapsed = Date.now() - startTime;
    // console.log(`${label} cache built: ${cacheMap.size} files indexed in ${elapsed}ms`);
}

// Prompt user for longer edge preferences
async function promptForLongerEdgeFiles(total100x70, total120x80) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // Helper to ask a yes/no question
    const askYesNo = (question) => {
        return new Promise((resolve) => {
            const ask = () => {
                rl.question(question + ' (y/n): ', (answer) => {
                    const normalized = answer.trim().toLowerCase();
                    if (normalized === 'y' || normalized === 'yes') {
                        resolve(true);
                    } else if (normalized === 'n' || normalized === 'no') {
                        resolve(false);
                    } else {
                        console.log('\x1b[31mPlease answer with y or n\x1b[0m');
                        ask();
                    }
                });
            };
            ask();
        });
    };

    // Helper to ask for a number
    const askNumber = (question, max) => {
        return new Promise((resolve) => {
            const ask = () => {
                rl.question(question, (answer) => {
                    if (answer.trim() === '') {
                        resolve(0);
                        return;
                    }
                    const num = parseInt(answer, 10);
                    if (isNaN(num) || !Number.isInteger(num) || num < 0) {
                        console.log('\x1b[31mError: Please enter a valid non-negative number.\x1b[0m');
                        ask();
                    } else if (num > max) {
                        console.log(`\x1b[31mError: Maximum available is ${max}\x1b[0m`);
                        ask();
                    } else {
                        resolve(num);
                    }
                });
            };
            ask();
        });
    };

    let target100x70 = 0;
    let target120x80 = 0;

    // Ask if user wants longer edge files
    const wantsLongerEdge = await askYesNo('\nDo you want to copy longer edge files?');
    
    if (wantsLongerEdge) {
        // Ask for 100x70
        if (total100x70 > 0) {
            console.log(`\n\x1b[36mAvailable 100x70 files: ${total100x70}\x1b[0m`);
            target100x70 = await askNumber('How many 100x70 longer edge files to copy? [Press Enter for 0]: ', total100x70);
        }
        
        // Ask for 120x80
        if (total120x80 > 0) {
            console.log(`\n\x1b[36mAvailable 120x80 files: ${total120x80}\x1b[0m`);
            target120x80 = await askNumber('How many 120x80 longer edge files to copy? [Press Enter for 0]: ', total120x80);
        }
    }

    rl.close();
    return { target100x70, target120x80 };
}


(async function () {
    if (process.platform === 'darwin') {    // OSX
        var printFilesSrcDirs = [
            '/Users/chadi/WWW/node-programs/copy-print-files/print-files',
            '/Users/chadi/WWW/node-programs/copy-print-files/print-files_3'
        ]
        var destDir = '/Users/chadi/WWW/node-programs/copy-print-files/print-files-newest-orders';
    } else if (process.platform === 'win32') {
        var printFilesSrcDirs = [
            'I:/print-files-new'
        ]
        var destDir = 'I:/print-files-destination';
    } else {
        console.log('Could not determine Operating System')
        return 0
        process.exit()
    }
    if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
    }
    fs.mkdirSync(destDir);
    
    // Build file cache for fast lookups
    await buildFileCache(printFilesSrcDirs, fileCache, 'Normal');
    
    // Note: -le (longer edge) files are now generated directly by print-file-generator
    // and are included in the main fileCache above

    // First, get the inventory list from the server so we know which products are already produced and for which we don't need a print file to be copied to the print file folder.
    const takeFromStock = {}
    let stockList = [];
    
    if (!TEST_MODE) {
        var stockListResponse = await requestFromServer({
            hostname: 'om.printedpaintings.de',
            port: 443,
            path: '/orders/get-inventory-list/orders_stock',
            method: 'GET',
            rejectUnauthorized: false
        })
        stockList = JSON.parse(stockListResponse);
        console.log('Stock list loaded from server.');
    } else {
        console.log('\x1b[33m⚠️  TEST MODE: Skipping stock list download. Stock will not be checked or modified.\x1b[0m');
    }

    const options = {
      hostname: 'om.printedpaintings.de',
      // hostname: 'http://www.prints-galore.lb',
      port: 443,
      path: '/orders/get-skus-meta-from-unprocessed-orders',
      method: 'GET',
      rejectUnauthorized: false
    }

    const req = https.request(options, res => {
        var body = ''
        var missingFiles = new Array()
        var copiedFiles = new Array()
        var copiedFilesCounter = 0;

        res.on('data', function(chunk) {
            body += chunk;
        });

        res.on('end', async function() {

            var metaItems = JSON.parse(body);
            var batchesCounter = 1 // meta endpoint is flat; treat as single batch for reporting
            var sortedEntries = []
            console.log('\r')
            console.log('SKUs retrieved from server, now searching and copying print files...')

            // Build a flat list of entries; sum total counts
            for (const it of metaItems) {
                if (exceptionSkusFromMissing.some(exception => it.sku.includes(exception))) continue;
                if (it.quantity <= 0) continue;
                if (it.sku.includes('100x70')) total100x70 += it.quantity;
                if (it.sku.includes('120x80')) total120x80 += it.quantity;
                numSkus += it.quantity;
            }
            
            // Prompt user for longer edge preferences
            const longerEdgeTargets = await promptForLongerEdgeFiles(total100x70, total120x80);
            target100x70LongerEdge = longerEdgeTargets.target100x70;
            target120x80LongerEdge = longerEdgeTargets.target120x80;
            console.log(`\nTarget 100x70 longer edge: ${target100x70LongerEdge}`);
            console.log(`Target 120x80 longer edge: ${target120x80LongerEdge}\n`);

            // Sorting priority: 100x70, 120x80, others
            const priority = (sku) => sku.includes('100x70') ? 0 : (sku.includes('120x80') ? 1 : 2);
            sortedEntries = metaItems
                .filter(it => it.quantity > 0)
                .sort((a,b) => priority(a.sku) - priority(b.sku));

            // Calculate exact number of files to copy AFTER stock check
            let totalFilesToCopy = 0;
            for (const entry of sortedEntries) {
                const sku = entry.sku;
                let toShipCount = entry.quantity;
                
                // Simulate stock check to get actual quantity to copy
                if (!TEST_MODE) {
                    let processed = 0;
                    for (const item of stockList) {
                        if (item === sku && processed < toShipCount) {
                            processed++;
                        }
                    }
                    toShipCount = Math.max(toShipCount - processed, 0);
                }
                
                // Account for triptych parts (3 files per SKU)
                const parts = sku.includes('drei') ? 3 : 1;
                totalFilesToCopy += toShipCount * parts;
            }
            
            console.log(`\nTotal files to copy: ${totalFilesToCopy}\n`);

            {
                // Iterate sorted entries, copy files
                // Process SKUs sequentially to avoid file lock conflicts, but copies within each SKU are parallel
                for (const entry of sortedEntries) {
                    const sku = entry.sku;
                    const baseSku = sku.split('_')[1];
                    let toShipCount = entry.quantity;
                    let merchantId = entry.merchant_id;

                    // Track processed items for the current SKU
                    let processed = 0;

                    // Create a new array, removing only the required number of occurrences
                    // Stock list contains plain sku strings without order suffix
                    stockList = stockList.filter(item => {
                      if (item === sku && processed < toShipCount) {
                        processed++; // Increment processed count
                        return false; // Skip this item (remove it)
                      }
                      return true; // Keep all other items
                    });

                    if (processed > 0) {
                        // Store order IDs for units that should be taken from stock
                        if (!takeFromStock[sku]) {
                            takeFromStock[sku] = [];
                        }
                        // Add order IDs for the units taken from stock
                        for (let i = 0; i < processed; i++) {
                            takeFromStock[sku].push(entry.order_id);
                        }
                        
                        // Update the skus value based on how many were processed
                        toShipCount = Math.max(toShipCount - processed, 0);

                        // If the quantity to print decreased to 0, skip this sku and proceed with the next
                        if (toShipCount === 0) {
                            continue;
                        }
                    }

                    var parts = sku.includes('drei') ? 3 : 1;
                    
                    // Check if this SKU contains a problematic motif ID
                    const isProblematic = problematicMotifIds.some(id => sku.includes(id));
                    const problematicSubDir = isProblematic ? 'problematic_colours/' : '';
                    
                    for (var part=1; part<=parts; part++) {
                        var suffixPart = parts > 1 ? '_Teil'+part : '';
                        var sizeName = sku.includes('drei') ? 'triptych' : /\d{2,4}x\d{2,4}/.exec(sku);
                        
                        if (sku.includes('P_')) {
                            var prodTypeSubDir = 'poster_paper/';
                        } else if (sku.includes('C_')) {
                            var prodTypeSubDir = 'poster_canvas/';
                        } else {
                            var prodTypeSubDir = '';
                        }
                        if (!fs.existsSync(destDir+'/'+problematicSubDir+prodTypeSubDir)) {
                            fs.mkdirSync(destDir+'/'+problematicSubDir+prodTypeSubDir, { recursive: true });
                        }

                        var printFileFound = false;
                        // This was for the version with batches
                        // if (!fs.existsSync(batchDir+'/'+prodTypeSubDir)) {
                        //     fs.mkdirSync(batchDir+'/'+prodTypeSubDir)
                        // }
                        // var sizeDir = batchDir+'/'+prodTypeSubDir+sizeName
                        
                        if (sizeName == '100x70' && copied100x70LongerEdge < target100x70LongerEdge) {
                            sizeDir = destDir+'/'+problematicSubDir+prodTypeSubDir+'100x70_longer_edge';
                            // Look for -le (longer edge) files that were generated by print-file-generator
                            let specialCopiesFound = 0;
                            
                            for (let copyIndex = 1; copyIndex <= toShipCount; copyIndex++) {
                                // New format: ORDER_ID-SKU-le.jpg or ORDER_ID-SKU-2-le.jpg
                                const copySuffix = copyIndex > 1 ? '-' + copyIndex : '';
                                const specialFilename = entry.order_id + '-' + sku + suffixPart + copySuffix + '-le.jpg';
                                
                                if (fileCache.has(specialFilename) && copied100x70LongerEdge < target100x70LongerEdge) {
                                    const specialPrintFilePath = fileCache.get(specialFilename);
                                    copiedFilesCounter = await copyPrintFile(sku, suffixPart, 1, specialPrintFilePath, sizeDir, copiedFilesCounter, copiedFiles, totalFilesToCopy);
                                    specialCopiesFound++;
                                    copied100x70LongerEdge++;
                                    printFileFound = true;
                                } else {
                                    break;
                                }
                            }
                        } else if (sizeName == '120x80' && copied120x80LongerEdge < target120x80LongerEdge) {
                            sizeDir = destDir+'/'+problematicSubDir+prodTypeSubDir+'120x80_longer_edge';
                            // Look for -le (longer edge) files that were generated by print-file-generator
                            let specialCopiesFound = 0;
                            
                            for (let copyIndex = 1; copyIndex <= toShipCount; copyIndex++) {
                                // New format: ORDER_ID-SKU-le.jpg or ORDER_ID-SKU-2-le.jpg
                                const copySuffix = copyIndex > 1 ? '-' + copyIndex : '';
                                const specialFilename = entry.order_id + '-' + sku + suffixPart + copySuffix + '-le.jpg';
                                
                                if (fileCache.has(specialFilename) && copied120x80LongerEdge < target120x80LongerEdge) {
                                    const specialPrintFilePath = fileCache.get(specialFilename);
                                    copiedFilesCounter = await copyPrintFile(sku, suffixPart, 1, specialPrintFilePath, sizeDir, copiedFilesCounter, copiedFiles, totalFilesToCopy);
                                    specialCopiesFound++;
                                    copied120x80LongerEdge++;
                                    printFileFound = true;
                                } else {
                                    break;
                                }
                            }
                        }

                        if (printFileFound === true) {
                            continue;
                        }

                        var sizeDir = destDir+'/'+problematicSubDir+prodTypeSubDir+sizeName;
                    
                    // New format: ORDER_ID-SKU.jpg or ORDER_ID-SKU-2.jpg (order ID comes first)
                    // For triptych: ORDER_ID-SKU_Teil1.jpg
                    // Try to find all copies based on toShipCount
                    let copiesFound = 0;
                    
                        for (let copyIndex = 1; copyIndex <= toShipCount; copyIndex++) {
                            // First copy has no suffix, subsequent copies have -2, -3, etc.
                            const copySuffix = copyIndex > 1 ? '-' + copyIndex : '';
                            const filename = entry.order_id + '-' + sku + suffixPart + copySuffix + '.jpg';
                            
                            if (fileCache.has(filename)) {
                                const printFilePath = fileCache.get(filename);
                                // Copy only this single file (numCopies = 1)
                                copiedFilesCounter = await copyPrintFile(sku, suffixPart, 1, printFilePath, sizeDir, copiedFilesCounter, copiedFiles, totalFilesToCopy);
                                copiesFound++;
                                printFileFound = true;
                            } else {
                                // If we can't find this copy, stop looking for higher numbers
                                break;
                            }
                        }
                        
                        // If we found fewer copies than expected, report missing files
                        if (copiesFound < toShipCount && !exceptionSkusFromMissing.some(exception => sku.includes(exception))) {
                            const missingCount = toShipCount - copiesFound;
                            // Start from the next copy number after the ones we found
                            for (let i = 0; i < missingCount; i++) {
                                const missingCopyIndex = copiesFound + i + 1;
                                const copySuffix = missingCopyIndex > 1 ? '-' + missingCopyIndex : '';
                                missingFiles.push(entry.order_id + '-' + sku + suffixPart + copySuffix + '.jpg');
                            }
                        }
                    }
                }
            }

            // Upload (via POST) the modified inventory list to the server database
            if (!TEST_MODE) {
                const res = await requestFromServer(
                    {
                        hostname: 'om.printedpaintings.de',
                        port: 443,
                        path: '/orders/update-stock-list/orders_stock',
                        method: 'POST',
                        rejectUnauthorized: false,
                        headers: {
                            'Content-Type': 'application/json',
                         'X-Secure-Key': 'YX2qXQwPls:}zwem7j6u80Y240u|Y'
                        }
                    },
                    JSON.stringify({stockList:stockList})
                );
                console.log('Stock list updated on server.');
            } else {
                console.log('\x1b[33m⚠️  TEST MODE: Skipping stock list update to server.\x1b[0m');
            }
            console.log('\r')
            console.log('--- \033[1;32m'+copiedFilesCounter+' file(s)\033[0m in '+batchesCounter+' batche(s) successfully copied.')
            if (copiedFiles.length > 0) {
                // console.log('\r')
                // for (copiedFile of copiedFiles) {
                //     console.log('- '+copiedFile)
                // }                                
            }
            console.log('\r')
            if (missingFiles.length > 0) {
                console.log('---------- The following files\033[0;31m WERE NOT FOUND:\033[0m ')
                console.log('\r')
                for (missingFile of missingFiles) {
                    console.log('- '+missingFile)
                }                
                console.log('\r')
            }
            console.log('\r')
            if (Object.keys(takeFromStock).length > 0) {
                console.log('\033[1;32m---------- THESE SKUs ARE ALREADY IN STOCK. PLZ TAKE THEM FROM THERE:\033[0m')
                console.log('\r')
                for (const skuStock in takeFromStock) {
                    const orderIds = takeFromStock[skuStock];
                    for (const orderId of orderIds) {
                        console.log('\033[1;32m- '+orderId+'-'+skuStock+'\033[0m')
                    }
                }                
                console.log('\r')
            }

            // Keep terminal open - wait for user to press Enter
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            rl.question('\nPress Enter to exit...', () => {
                rl.close();
                process.exit(0);
            });

        });

    })

    req.on('error', error => {
        console.error(error)
        
        // Keep terminal open on error too
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('\nPress Enter to exit...', () => {
            rl.close();
            process.exit(1);
        });
    })

    req.end()
}());


async function copyPrintFile(sku, suffixPart, numCopies, printFilePath, sizeDir, copiedFilesCounter, copiedFiles, totalFilesToCopy) {
    if (!fs.existsSync(sizeDir)) {
        fs.mkdirSync(sizeDir, { recursive: true })
    }
    const baseName = sku + suffixPart;
    const key = sizeDir + '/' + baseName;
    let index = nextCopyIndex.get(key) || 1;
    
    // Create array of copy operations to run in parallel
    const copyOperations = [];
    for (let i = 1; i <= numCopies; i++) {
        const useSuffix = (numCopies > 1) || (index > 1);
        const suffixCopy = useSuffix ? '_' + index : '';
        const newFilePath = sizeDir + '/' + baseName + suffixCopy + '.jpg';
        
        copyOperations.push(
            fsPromises.copyFile(printFilePath, newFilePath).then(() => {
                copiedFiles.push(baseName + suffixCopy + '.jpg');
                return 1; // Return 1 to count this copy
            })
        );
        index++;
    }
    
    // Execute all copies in parallel
    await Promise.all(copyOperations);
    copiedFilesCounter += numCopies;
    
    if (copiedFilesCounter % 50 === 0) {
        console.log('- ' + copiedFilesCounter + ' of ' + totalFilesToCopy + ' files copied.')
    }
    
    nextCopyIndex.set(key, index);
    return copiedFilesCounter;
}


// Request SKUs from the server
async function requestFromServer(options, data = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';

            res.on('data', (chunk) => {
                responseBody += chunk;
            });

            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseBody));
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.setTimeout(5000, () => {
            req.abort();
            reject(new Error('Server Request Timeout.'));
        });

        // Write the body if data is provided
        if (data) {
            req.write(data); // Write the request body
        }

        req.end();
    });
}

// process.stdin.resume() is no longer needed - readline handles keeping terminal open





var copyBadImages = function() {
    var imgName = allFiles[imgCounter]
    imgCounter++
    var pathToSrcFile = srcDir3 + "/" + imgName
    var pathToDstFile = dstDir + "/" + imgName
    fs.copyFileSync(pathToSrcFile, pathToDstFile)
    console.log(pathToSrcFile + ' was copied')
    if (imgCounter < allFiles.length)
        copyBadImages()
}