// Downloads the skus from the unprocessed orders and copies the respective print 
// files to a specified folder
// TO GENERATE AN EXECUTABLE, type "pkg copy-print-files.js" in this directory


// const sharp = require('sharp')
// const $ = require('jquery')
const fs = require('fs')
const https = require('https');
// var path = require('path');

const exceptionSkusFromMissing = ['posterframe', 'posterhanger', 'framing_service'];
var hundredSeventyCounter = 0;
var totalSpecialFiles = 0;
var totalHundredSeventy = 0;
const targetSpecialFiles = 40
var numSkus = 0;
// Keep a running destination filename counter per SKU+part+sizeDir to avoid overwriting
// when the same print file appears across multiple orders.
const nextCopyIndex = new Map();
const isMonday = new Date().getDay() === 1; // 1 = Monday in JavaScript's getDay()
// const isWednesday = new Date().getDay() === 3; // 3 = Wednesday in JavaScript's getDay()
const isFriday = new Date().getDay() === 5; // 5 = Friday in JavaScript's getDay();


(async function () {
    if (process.platform === 'darwin') {    // OSX
        var printFilesSrcDirs = [
            '/Users/chadi/WWW/node-programs/copy-print-files/print-files',
            '/Users/chadi/WWW/node-programs/copy-print-files/print-files_3'
        ]
        var destDir = '/Users/chadi/WWW/node-programs/copy-print-files/print-files-newest-orders';
    } else if (process.platform === 'win32') {
        var printFilesSrcDirs = [
            'I:/print-files',
            'F:/06_Print_Files',
        ]
        var quadPrintFilesSrcDirs = ['I:/print-files-original', 'F:/06_Print_Files-original']
        var destDir = 'C:/Users/printer-manager/Desktop/print-files-newest-orders';
    } else {
        console.log('Could not determine Operating System')
        return 0
        process.exit()
    }
    if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
    }
    fs.mkdirSync(destDir);

    // First, get the inventory list from the server so we know which products are already produced and for which we don't need a print file to be copied to the print file folder.
    const takeFromStock = {}
    var stockList = await requestFromServer({
        hostname: 'om.printedpaintings.de',
        port: 443,
        path: '/orders/get-inventory-list/orders_stock',
        method: 'GET',
        rejectUnauthorized: false
    })
    var stockList = JSON.parse(stockList);

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
                if (it.quantity <= 0) continue;
                if (it.sku.includes('100x70')) totalHundredSeventy += it.quantity;
                numSkus += it.quantity;
            }

            // Sorting priority: 100x70, 120x80, others
            const priority = (sku) => sku.includes('100x70') ? 0 : (sku.includes('120x80') ? 1 : 2);
            sortedEntries = metaItems
                .filter(it => it.quantity > 0)
                .sort((a,b) => priority(a.sku) - priority(b.sku));

            {
                // Iterate sorted entries, copy files
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
                        // Update the skus value based on how many were processed
                        toShipCount = Math.max(toShipCount - processed, 0);

                        takeFromStock[sku] = processed
                        // If the quantity to print decreased to 0, skip this sku and proceed with the next
                        if (toShipCount === 0) {
                            continue
                        }
                    }

                    var parts = sku.includes('drei')
                        ?3
                        :1
                    for (var part=1; part<=parts; part++) {
                        var suffixPart = parts > 1
                            ?'_Teil'+part
                            :''
                        var sizeName = sku.includes('drei')
                            ?'triptych'
                            :/\d{2,4}x\d{2,4}/.exec(sku)
                        // var rollSizeDir = batchDir+'/'+sizeNameToRollSize[sizeName]
                        if (sku.includes('P_')) {
                            var prodTypeSubDir = 'poster_paper/'
                        } else if (sku.includes('C_')) {
                            var prodTypeSubDir = 'poster_canvas/'
                        } else if (sku.includes('L_') && merchantId==4) {
                            var prodTypeSubDir = 'stretched_canvas_cotton/'
                        } else {
                            var prodTypeSubDir = ''
                        }
                        if (!fs.existsSync(destDir+'/'+prodTypeSubDir)) {
                            fs.mkdirSync(destDir+'/'+prodTypeSubDir)
                        }

                        var printFileFound = false
                        // This was for the version with batches
                        // if (!fs.existsSync(batchDir+'/'+prodTypeSubDir)) {
                        //     fs.mkdirSync(batchDir+'/'+prodTypeSubDir)
                        // }
                        // var sizeDir = batchDir+'/'+prodTypeSubDir+sizeName
                        
                        if (sizeName == '100x70' && totalSpecialFiles < targetSpecialFiles && !prodTypeSubDir.includes('stretched_canvas_cotton') && (isMonday || isFriday)) {
                            sizeDir = destDir+'/'+prodTypeSubDir+'100x70_longer_edge';
                            var specialprintFilesSrcDirs = ['I:/print-files-original', 'F:/06_Print_Files-original'];
                            for (var printFilesSrcDir of specialprintFilesSrcDirs) {
                                var specialPrintFilePath = printFilesSrcDir+'/'+(entry.is_multi_l_sku_order && sku.includes('L_') ? sku+'-'+entry.order_id : sku)+suffixPart+'.jpg'
                                if (fs.existsSync(specialPrintFilePath)) {
                                    copiedFilesCounter = copyPrintFile(sku, suffixPart, toShipCount, specialPrintFilePath, sizeDir, copiedFilesCounter, copiedFiles, numSkus);
                                    printFileFound = true;
                                    totalSpecialFiles += toShipCount;
                                    break;
                                }
                            }
                        } else if (sizeName == '120x80' && totalHundredSeventy < targetSpecialFiles && totalSpecialFiles < targetSpecialFiles && !prodTypeSubDir.includes('stretched_canvas_cotton') && (isMonday || isFriday)) {
                            sizeDir = destDir+'/'+prodTypeSubDir+'120x80_longer_edge';
                            var specialprintFilesSrcDirs = ['I:/print-files-original', 'F:/06_Print_Files-original'];
                            for (var printFilesSrcDir of specialprintFilesSrcDirs) {
                                var specialPrintFilePath = printFilesSrcDir+'/'+(entry.is_multi_l_sku_order && sku.includes('L_') ? sku+'-'+entry.order_id : sku)+suffixPart+'.jpg'
                                if (fs.existsSync(specialPrintFilePath)) {
                                    copiedFilesCounter = copyPrintFile(sku, suffixPart, toShipCount, specialPrintFilePath, sizeDir, copiedFilesCounter, copiedFiles, numSkus);
                                    printFileFound = true;
                                    totalSpecialFiles += toShipCount;
                                    break;
                                }
                            }
                        }

                        if (printFileFound === true) {
                            continue;
                        }

                        for (var printFilesSrcDir of printFilesSrcDirs) {
                            var sizeDir = destDir+'/'+prodTypeSubDir+sizeName
                            const filenameSku = (entry.is_multi_l_sku_order && sku.includes('L_')) ? sku+'-'+entry.order_id : sku;
                            printFilePath = printFilesSrcDir+'/'+filenameSku+suffixPart+'.jpg'
                            if (fs.existsSync(printFilePath)) {
                                copiedFilesCounter = copyPrintFile(sku, suffixPart, toShipCount, printFilePath, sizeDir, copiedFilesCounter, copiedFiles, numSkus)
                                printFileFound = true
                                break
                            }
                        }                        
                        
                        if (printFileFound === false && !exceptionSkusFromMissing.some(exception => sku.includes(exception))) {
                            missingFiles.push(sku+suffixPart+'.jpg')
                        }
                    }
                }
            }

            // Upload (via POST) the modified inventory list to the server database
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
                    console.log('\033[1;32m- '+takeFromStock[skuStock]+' x '+skuStock+'\033[0m')
                }                
                console.log('\r')
            }

        });

    })

    req.on('error', error => {
        console.error(error)
    })

    req.end()
}());


function copyPrintFile(sku, suffixPart, numCopies, printFilePath, sizeDir, copiedFilesCounter, copiedFiles, numSkus) {
    if (!fs.existsSync(sizeDir)) {
        fs.mkdirSync(sizeDir)
    }
    const baseName = sku + suffixPart;
    const key = sizeDir + '/' + baseName;
    let index = nextCopyIndex.get(key) || 1;
    for (let i = 1; i <= numCopies; i++) {
        // Preserve original behavior: first ever copy has no suffix; from second onward use running suffix
        const useSuffix = (numCopies > 1) || (index > 1);
        const suffixCopy = useSuffix ? '_' + index : '';
        const newFilePath = sizeDir + '/' + baseName + suffixCopy + '.jpg';
        fs.copyFileSync(printFilePath, newFilePath)
        copiedFilesCounter++
        copiedFiles.push(baseName + suffixCopy + '.jpg')
        if (copiedFilesCounter % 50 === 0) {
            console.log('- ' + copiedFilesCounter + ' of ' + numSkus + ' files copied.')
        }
        index++;
    }
    nextCopyIndex.set(key, index);
    return copiedFilesCounter
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

process.stdin.resume();





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