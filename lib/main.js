/* jslint node:true, plusplus: true */
/* jshint node: true */
"use strict";

var fs = require("fs"),
    fspath = require("path"),
    aws = require("aws-sdk"),
    glob = require("glob"),
    jsonFile = require("jsonfile"),
    console = require("better-console"),
    prettyjson = require("prettyjson");

function event(message, data, errorOrCallback, callbackOrCallbackData, callbackData) {
    var error, callback;
    if (typeof errorOrCallback === "function") {
        error = null;
        callback = errorOrCallback;
        callbackData = callbackOrCallbackData;
    }
    else {
        error = errorOrCallback;
        callback = callbackOrCallbackData;
    }
    if (error) {
        if (!data) data = {};
        data.error = error;
    }
    if (message || data) message = prettyjson.render({ message: message, data: data });
    if (message) console[error ? "error" : "log"](message);
    if (callback) callback(error, callbackData);
}

function getEC2Client(region) {
    return new aws.EC2( { region: region } );
}

function preProcess(regionName, templatePathPatterns, callback) {
    getEC2Client(regionName).describeRegions(function(error, regionsDescription) {
        if (error) event("Unable to get regions", { region: regionName }, error, callback);
        else {
            var regionNames = regionsDescription.Regions.map(function(o) { return o.RegionName; });
            if (!Array.isArray(templatePathPatterns) || templatePathPatterns.length === 0) templatePathPatterns = [ "./*.cloudformation" ];
            templatePathPatterns.forEach(function(templatePathPattern) {
                glob(templatePathPattern, function (error, templatePaths) {
                    if (error) event("Unable to find templates", templatePathPatterns, error, callback);
                    else {
                        var templatesToDo = templatePaths.length,
                            templateCallback = function(message, data, error) {
                            event(message, data, error);
                            if (--templatesToDo === 0) event("Templates completed", { paths: templatePaths }, callback, templatePaths);
                        };
                        templatePaths.forEach(function(templatePath) {
                            var templateName = fspath.basename(templatePath),
                                templateInfo = { template : templateName };
                            jsonFile.readFile(templatePath, function (error, template) {
                                if (error) templateCallback("Unable to read template", templateInfo, error);
                                else {
                                    var originalTemplateString = JSON.stringify(template),
                                        tasksToDo = 2, // resources + mappings
                                        taskCallback = function(message, data, error) {
                                            event(message, data, error);
                                            if (error) templateCallback("Template not saved", templateInfo);
                                            else if (--tasksToDo === 0 ) {
                                                var templateString = JSON.stringify(template),
                                                    templateChanged = (templateString !== originalTemplateString);
                                                if (templateChanged) jsonFile.writeFile(templatePath, template, function(error) {
                                                    templateCallback(error ? "Unable to save template" : "Template completed", templateInfo, error);
                                                });
                                                else templateCallback("Template unchanged", templateInfo);
                                            }
                                        };
                                    event("Pre-processing template", { name : templateName, tasks: tasksToDo });
                                    var directoryPath = templatePath + ".d",
                                        resourcesPath = fspath.join(directoryPath, "resources"),
                                        filePathsPattern = directoryPath + "/**";
                                    glob(filePathsPattern, function(error, filePaths) {
                                        if (error) taskCallback("Unable to get file paths", { pattern : filePathsPattern }, error);
                                        else {
                                            var filesToProcess = filePaths.length,
                                                fileCallback = function(message, data, error) {
                                                    event(message, data, error);
                                                    if (--filesToProcess === 0) taskCallback("Includes completed", templateInfo);
                                                };
                                            filePaths.forEach(function(filePath) {
                                                var fileInfo = { template: templateName, path: filePath },
                                                    pathParts = fspath.relative(directoryPath, filePath).split(fspath.sep);
                                                if (pathParts.length <= 2) fileCallback();
                                                else if (pathParts.some(function(pathPart) { return pathPart === "."; })) fileCallback("Ignoring include as it is a hidden file", fileInfo);
                                                else {
                                                    console.log(pathParts[0]);
                                                    var rootType = pathParts[0];
                                                    switch (rootType) {
                                                        case "resources":
                                                            var resourceKey = pathParts[1],
                                                                resource = template.Resources[resourceKey],
                                                                match = pathParts[2].match(/^configs|userdata(\.ps1|\.cmd|\.sh|)$/);
                                                            fileInfo.resource = resourceKey;
                                                            if (!match) fileCallback("File must be config or userdata", fileInfo);
                                                            else {
                                                                var includeType, // config or userdata
                                                                    configKey, 
                                                                    configType, // file or command
                                                                    userdataWrapper, // powershell, cmd or empty
                                                                    ignore;
                                                                switch (match[0]) {
                                                                    case "configs":
                                                                        includeType = "config";
                                                                        if (pathParts.length <=4) {
                                                                            fileCallback();
                                                                            ignore = true;
                                                                        }
                                                                        else {
                                                                            fileInfo.config = configKey = pathParts[3];
                                                                            var fileOrCommandMatch = pathParts[4].match(/^files|commands$/);
                                                                            if (!fileOrCommandMatch) {
                                                                                fileCallback("Config file must be file or command", fileInfo);
                                                                                ignore = true;
                                                                            }
                                                                            else {
                                                                                switch (fileOrCommandMatch[0]) {
                                                                                    case "files":
                                                                                        configType = "file";
                                                                                        break;
                                                                                    case "commands":
                                                                                        configType = "command";
                                                                                        break;
                                                                                }
                                                                                fileInfo.configType = configType;
                                                                            }
                                                                        }
                                                                        break;
                                                                    default:
                                                                        includeType = "userdata";
                                                                        switch (match[1]) {
                                                                            case ".ps1":
                                                                                userdataWrapper = "powershell";
                                                                                break;
                                                                            case ".cmd":
                                                                                userdataWrapper = "script";
                                                                                break;
                                                                        }
                                                                        fileInfo.userdataType = match[1];
                                                                }
                                                                fileInfo.type = includeType;
                                                                if (!ignore) fs.stat(filePath, function(error, stat) {
                                                                    if (error) fileCallback("Unable to get file stats", fileInfo, error);
                                                                    else if (!stat.isFile()) fileCallback();
                                                                    //need to support ignoring of windows system/hidden files here
                                                                    else fs.readFile(filePath, "utf8", function (error, contentString) {
                                                                        if (error) fileCallback(error.errno === 34 ? "File not found" : "Unable to read file", fileInfo, error);
                                                                        else {
                                                                            var includeObject, 
                                                                                includeProperty,
                                                                                objectPath = "Resources/" + resourceKey;
                                                                            switch (includeType) {
                                                                                case "config":
                                                                                    var keyParts = pathParts.slice(5);
                                                                                    switch (configType) {
                                                                                        case "file":
                                                                                            for (var i = 0; i < keyParts.length; i++) {
                                                                                                var original = keyParts[i],
                                                                                                    working = original;
                                                                                                //if first part is e.g. C$, change to C:
                                                                                                if (i === 0) {
                                                                                                    var match = working.match(/^([A-z])\$$/);
                                                                                                    if (match) working = match[1] + ":";
                                                                                                }
                                                                                                //if part starts with $$ or $., remove the first $
                                                                                                var dollarMatch = working.match(/^\$(\.\$.*)$/);
                                                                                                if (dollarMatch) working = dollarMatch[1];
                                                                                                if (working !== original) keyParts[i] = working;
                                                                                            }
                                                                                            includeProperty = "content";
                                                                                            break;
                                                                                        case "command":
                                                                                            includeProperty = "command";
                                                                                            break;
                                                                                    }
                                                                                    var key = keyParts.join("/"),
                                                                                        typeKey = configType + "s";
                                                                                    fileInfo.key = key;
                                                                                    objectPath += "/Metadata/AWS::CloudFormation::Init/" + configKey + "/" + typeKey + "/\"" + key + "\"";
                                                                                    includeObject = resource.Metadata["AWS::CloudFormation::Init"][configKey][typeKey][key];
                                                                                    break;
                                                                                case "userdata":
                                                                                    if (userdataWrapper && contentString) contentString = "<" + userdataWrapper + ">\n" + contentString + "\n</" + userdataWrapper + ">";
                                                                                    objectPath += "/Properties";
                                                                                    includeObject = resource.Properties;
                                                                                    includeProperty = "UserData";
                                                                                    break;
                                                                            }
                                                                            fileInfo.objectPath = (objectPath += "/" + includeProperty);
                                                                            if (!includeObject) fileCallback("Template object not found", fileInfo);
                                                                            else {
                                                                                var originalContentString = JSON.stringify(includeObject[includeProperty]),
                                                                                    contentArray = [];
                                                                                for (var i = 0; ; true) {
                                                                                    var searchString = contentString.substring(i),
                                                                                        attRefMatch = searchString.match(/(?:\{\{((?:b64)?ref) ([\w.:]*)\}\})|(?:\{\{(att) (\w*) ([\w.]*)\}\})/),
                                                                                        stringToPush = null,
                                                                                        j;
                                                                                    if (!attRefMatch) stringToPush = searchString;
                                                                                    else {
                                                                                        j = attRefMatch.index;
                                                                                        if (j > 0) stringToPush = searchString.substring(0, j);
                                                                                    }
                                                                                    if (stringToPush) {
                                                                                        var lastIndex = contentArray.length - 1;
                                                                                        if (lastIndex > -1) {
                                                                                            var last = contentArray[lastIndex];
                                                                                            if (typeof last === "string") {
                                                                                                contentArray[lastIndex] = last + stringToPush;
                                                                                                stringToPush = null;
                                                                                            }
                                                                                        }
                                                                                        if (stringToPush) contentArray.push(stringToPush);
                                                                                    }
                                                                                    if (!attRefMatch) break;
                                                                                    var variableType = (attRefMatch[1] || attRefMatch[3]);
                                                                                    if (variableType) {
                                                                                        var variable = null;
                                                                                        switch (variableType) {
                                                                                            case "ref":
                                                                                            case "b64ref":
                                                                                                variable = { "Ref": attRefMatch[2] };
                                                                                                if (variableType === "b64ref") variable = { "Fn::Base64" : variable };
                                                                                                break;
                                                                                            case "att":
                                                                                                variable = { "Fn::GetAtt": [ attRefMatch[4], attRefMatch[5] ] };
                                                                                                break;
                                                                                        }
                                                                                        contentArray.push(variable);
                                                                                        var variableInfo = { 
                                                                                            template: templateName,
                                                                                            type: variableType,
                                                                                            string: attRefMatch[0], 
                                                                                            object: JSON.stringify(variable)
                                                                                        };
                                                                                        event("Variable found", variableInfo);
                                                                                    }
                                                                                    i += j + attRefMatch[0].length;
                                                                                }
                                                                                fileInfo.variableCount = contentArray.filter(function(o) { 
                                                                                    return typeof o === "object"; 
                                                                                }).length;
                                                                                var contentObject = (contentArray.length === 1) ? contentArray[0] : { "Fn::Join": [ "", contentArray ] };
                                                                                if (contentObject && (includeType === "userdata")) contentObject = { "Fn::Base64": contentObject };
                                                                                contentString = JSON.stringify(contentObject);
                                                                                var contentChanged = (contentString !== originalContentString);
                                                                                if (contentChanged) includeObject[includeProperty] = contentObject;
                                                                                fileCallback(contentChanged ? "Include changed" : "Include unchanged", fileInfo);
                                                                            }
                                                                        }
                                                                    });
                                                                });
                                                            }
                                                    }
                                                }
                                            });
                                        }
                                    });
                                    var mappingsPath = fspath.join(directoryPath, "mappings"),
                                        mappingPathsPattern = mappingsPath + "/*";
                                    glob(mappingPathsPattern, function(error, mappingPaths) {
                                        if (error) taskCallback("Unable to get mappings paths", { pattern : mappingPathsPattern }, error);
                                        else {
                                            var mappingsToProcess = mappingPaths.length,
                                                mappingCallback = function(message, data, error) {
                                                event(message, data, error);
                                                if (--mappingsToProcess === 0) taskCallback("Mappings completed", templateInfo);
                                            };
                                            mappingPaths.forEach(function(mappingPath) {
                                                var mappingExtension = fspath.extname(mappingPath),
                                                    mappingName = fspath.basename(mappingPath, mappingExtension),
                                                    mappingInfo = {
                                                        template: templateName,
                                                        path: mappingPath,
                                                        name: mappingName
                                                    };
                                                jsonFile.readFile(mappingPath, function(error, mapping) {
                                                    if (error) {
                                                        if (error.no === 34) taskCallback("Config not found", mappingInfo);
                                                        else taskCallback("Unable to read mapping", mappingInfo, error);
                                                    }
                                                    else {
                                                        var type = mapping.type,
                                                            templateMapping = template.Mappings[mappingName];
                                                        mappingInfo.type = type;
                                                        if (!templateMapping) mappingCallback("Mapping ignored", mappingInfo);
                                                        else {
                                                            switch (mapping.type) {
                                                                case "ami":
                                                                    var ami = mapping.ami,
                                                                        owner = ami.owner,
                                                                        name = ami.name,
                                                                        amiMappingRegionsToDo = regionNames.length,
                                                                        amiMappingRegionCallback = function(message, data, error) {
                                                                            event(message, data, error);
                                                                            if (--amiMappingRegionsToDo === 0) mappingCallback("Regions' AMIs completed", mappingInfo);
                                                                        };
                                                                    mappingInfo.ami = { owner: owner, name: name };
                                                                    regionNames.forEach(function(regionName) {
                                                                        mappingInfo.region = regionName;
                                                                        var amiMappingRegion = templateMapping[regionName],
                                                                            originalAmiId = amiMappingRegion ? amiMappingRegion.ID : null;
                                                                        event("Searching for AMI", mappingInfo);
                                                                        getEC2Client(regionName).describeImages({ 
                                                                            Owners: [ owner ], 
                                                                            Filters: [ { Name: "name", Values: [ name ] } ]
                                                                        }, function(error, amisDescription) {
                                                                            if (error) amiMappingRegionCallback("AMI not found", mappingInfo, error);
                                                                            else {
                                                                                var amis = amisDescription.Images.sort(function(a, b) {
                                                                                    a = a.Name;
                                                                                    b = b.Name;
                                                                                    return (a > b) ? 1 : ((a < b) ? -1 : 0);
                                                                                });
                                                                                if (amis.length === 0) amiMappingRegionCallback("AMI not found", mappingInfo);
                                                                                else {
                                                                                    var ami = amis[0],
                                                                                        amiId = ami.ImageId,
                                                                                        amiChanged = (amiId !== originalAmiId);
                                                                                    mappingInfo.ami = { 
                                                                                        name: ami.Name, 
                                                                                        id: amiId, 
                                                                                        owner: ami.ImageOwnerAlias, 
                                                                                        platform: ami.Platform, 
                                                                                        architecture: ami.Architecture 
                                                                                    };
                                                                                    if (amiChanged) {
                                                                                        if (originalAmiId) mappingInfo.originalAmiId = originalAmiId;
                                                                                        templateMapping[regionName] = { ID: amiId };
                                                                                    }
                                                                                    amiMappingRegionCallback(amiChanged ? "AMI changed" : "AMI unchanged", mappingInfo);
                                                                                    delete mappingInfo.amiId;
                                                                                    delete mappingInfo.previousAmiId;
                                                                                }
                                                                            }
                                                                        });
                                                                        delete mappingInfo.region;
                                                                    });
                                                                    break;
                                                                default:
                                                                    mappingCallback("Currently, only AMI mappings supported", mappingInfo);
                                                                    break;
                                                            }
                                                        }
                                                    }
                                                });
                                            });
                                        }
                                    });
                                }
                            });
                        });
                    }
                });
            });
        }
    });
}

module.exports = preProcess;
