/* jslint node:true, plusplus: true */
/* jshint node: true */
"use strict";

var fs = require("fs"),
    fspath = require("path"),
    aws = require("aws-sdk"),
    glob = require("glob"),
    recursiveReaddir = require("recursive-readdir"),
    jsonFile = require("jsonfile"),
    console = require("better-console"),
    prettyjson = require("prettyjson");

function event(message, info, error) {
    if (error) {
        if (!info) info = { };
        info.error = error;
    }
    var text = prettyjson.render(info);
    if (text) {
        if (message) message += "\n";
        message += text;
    }
    if (message) console[error ? "error" : "log"]("\n" + message);
}

function getEC2Client(region) {
    return new aws.EC2( { region: region } );
}

function getRegionAmiId(templateName, mappingName, regionName, amiNamePattern, amiOwner, amiId, callback) {
    var regionAmiInfo = {
        templateName: templateName,
        mappingName: mappingName,
        regionName: regionName,
        amiNamePattern: amiNamePattern,
        amiOwner: amiOwner,
        amiId: amiId
    };
    getEC2Client(regionName).describeImages({ 
            Owners: [ amiOwner ], 
            Filters: [ { Name: "name", Values: [ amiNamePattern ] } ]
        }, function(error, result) {
            if (error) {
                event("Error searching for AMI", regionAmiInfo, error);
                callback(error);
                return;
            }
            var amis = result.Images.sort(function(a, b) {
                a = a.Name;
                b = b.Name;
                return (a > b) ? 1 : ((a < b) ? -1 : 0);
            });
            if (amis.length === 0) {
                event("AMI not found", regionAmiInfo);
                callback();
                return;
            }
            var ami = amis[0],
                amiChanged = (amiId && (amiId !== ami.ImageId));
            if (amiChanged) regionAmiInfo.previousAmiId = amiId;
            amiId = regionAmiInfo.amiId = ami.ImageId;
            var amiName = regionAmiInfo.amiName = ami.Name;
            event(amiChanged ? "AMI changed" : "AMI unchanged", regionAmiInfo);
            callback(null, { id: amiId, name: amiName });
    });
}

function processAmiMapping(templateName, templateObject, mappingName, regionNames, amiNamePattern, amiOwner, callback) {
    var info = {
            templateName: templateName,
            mappingName: mappingName,
            amiNamePattern: amiNamePattern,
            amiOwner: amiOwner,
            amiIds: {}
        },
        toDo = regionNames.length,
        amiIds = info.amiIds;
    regionNames.forEach(function(regionName) {
        var templateRegionMapping = templateObject[regionName];
        getRegionAmiId(templateName, mappingName, regionName, amiNamePattern, amiOwner, templateRegionMapping ? templateRegionMapping.ID : null, function(error, result){
            if (!error) {
                var o = { 
                    id: result.id,
                    name: result.name
                };
                amiIds[regionName] = o;
                templateObject[regionName] = o;
            }
            if (--toDo === 0) {
                event("AMI mapping processed", info);
                callback(null, amiIds);
            }
        });
    });

}

function loadInclude(path, callback) {
    fs.readFile(path, "utf8", function (error, text) {
        event(error ? "Error loading include" : "Include loaded", { path : path }, error);
        callback(error, text);
    });
}

function loadMapping(path, callback) {
    jsonFile.readFile(path, function (error, object) {
        event(error ? "Error loading mapping" : "Mapping loaded", { path : path }, error);
        callback(error, object);
    });
}

function loadTemplate(path, callback) {
    jsonFile.readFile(path, function (error, object) {
        event(error ? "Error loading template" : "Template loaded", { path: path }, error);
        callback(error, object);
    });                    
}

function saveTemplate(object, originalText, path, callback) {
    var text = JSON.stringify(object),
        notChanged = (text == originalText);
    if (notChanged) event("Template not changed", { path: path }, null, callback);
    else jsonFile.writeFile(path, object, function(error) {
        event(error ? "Unable to save template" : "Template completed", { path: path }, error);
        callback(error, object);
    });
}


function getIncludeName(fileParts) {
    var nameParts = [],
        isWindows = false;
    for (var i = 0; i < fileParts.length; i++) {
        var part = fileParts[i];
        // windows volumes: if first part is e.g. C$, change to C:
        if (i === 0) {
            var match = part.match(/^([A-z])\$$/);
            if (match) {
                isWindows = true;
                part = match[1] + ":";
            }
        }
        // hidden files: if part starts with $$ or $., remove the first $
        var dollarMatch = part.match(/^\$(\.\$.*)$/);
        if (dollarMatch) part = dollarMatch[1];
        nameParts[i] = part;
    }
    return (isWindows ? "" : "/") + nameParts.join("/");
}

function processMapping(templateName, mappingsTemplate, mappingPath, regionNames, callback) {
    loadMapping(mappingPath, function(error, mapping) {
        if (error) {
            callback(error);
            return;
        }
        var mappingName = fspath.basename(mappingPath, fspath.extname(mappingPath)),
            mappingInfo = {
                templateName: templateName,
                mappingName: mappingName,
                mappingPath: mappingPath
            };
        var mappingTemplate = mappingsTemplate[mappingName];
        if (!mappingTemplate) {
            event("Mapping ignored", mappingInfo);
            callback();
            return;
        }
        switch (mapping.type) {
            case "ami":
                var ami = mapping.ami;
                processAmiMapping(templateName, mappingTemplate, mappingName, regionNames, ami.name, ami.owner, callback);
                break;
            default:
                event("Only AMI mappings supported", mappingInfo);
                callback();
                break;
        }
    });
}

function parseIncludeText(includeInfo, includeTemplate, propertyName, text) {
    var originalText = JSON.stringify(includeTemplate[propertyName]),
        contentArray = [];
    for (var i = 0; ; true) {
        var searchString = text.substring(i),
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
            event("Variable found", { 
                templateName: includeInfo.templateName,
                includePath: includeInfo.includePath,
                variableType: variableType,
                variableText: attRefMatch[0], 
                variableObject: JSON.stringify(variable)
            });
        }
        i += j + attRefMatch[0].length;
    }
    includeInfo.variableCount = contentArray.filter(function(o) { 
        return typeof o === "object"; 
    }).length;
    var contentObject = (contentArray.length === 1) ? contentArray[0] : { "Fn::Join": [ "", contentArray ] };
    if (contentObject && (includeInfo.includeType === "userdata")) contentObject = { "Fn::Base64": contentObject };
    text = JSON.stringify(contentObject);
    var isChanged = (text !== originalText);
    if (isChanged) includeTemplate[propertyName] = contentObject;
    event(isChanged ? "Include changed" : "Include unchanged", includeInfo);
}

function processInclude(templateName, resourcesTemplate, includePath, includePathParts, callback) {
    var includeInfo = {
            templateName: templateName,
            includePath: includePath
        };
    if (includePathParts.length <= 2) {
        event("Include file path not deep enough", includeInfo);
        callback();
        return;
    }
    var resourceName = includePathParts[1],
        resourceTemplate = resourcesTemplate[resourceName];
    includeInfo.resourceName = resourceName;
    if (!resourceTemplate) {
        event("Resource not found in template", includeInfo);
        callback();
        return;
    }
    var configsOrUserdataMatch = includePathParts[2].match(/^configs|userdata(\.ps1|\.cmd|\.sh|)$/);
    if (!configsOrUserdataMatch) {
        event("Include file must be config file or command, or userdata", includeInfo);
        callback();
        return;
    }
    var configName,
        includeType;
    switch (configsOrUserdataMatch[0]) {
        case "configs":
            if (includePathParts.length <=4) {
                callback();
                return;
            }
            includeInfo.configName = configName = includePathParts[3];
            var fileOrCommandMatch = includePathParts[4].match(/^files|commands$/);
            if (!fileOrCommandMatch) {
                event("Config file must be file or command", includeInfo);
                callback();
                return;
            }
            switch (fileOrCommandMatch[0]) {
                case "files":
                    includeType = "file";
                    break;
                case "commands":
                    includeType = "command";
                    break;
            }
            break;
        default:
            includeType = "userdata";
            var userdataType;
            switch (includeInfo.extension) {
                case ".ps1":
                    userdataType = "powershell";
                    break;
                case ".cmd":
                    userdataType = "script";
                    break;
            }
            includeInfo.userdataType = userdataType;
    }
    includeInfo.includeType = includeType;
    loadInclude(includePath, function (error, text) {
        if (error) {
            event("Error reading include file", includeInfo, error);
            callback(error);
            return;
        }
        var includeTemplate, 
            propertyName;
        switch (includeType) {
            case "file":
            case "command":
                var metadataTemplate = resourceTemplate.Metadata["AWS::CloudFormation::Init"];
                if (!metadataTemplate) {
                    event("Metadata template not found", includeInfo);
                    callback();
                    return;
                }
                var configTemplate = metadataTemplate[configName];
                if (!configTemplate) {
                    event("Config template not found", includeInfo);
                    callback();
                    return;
                }
                var includesTemplate = configTemplate[includeType + "s"];
                if (!includesTemplate) {
                    event("Includes template not found", includeInfo);
                    callback();
                    return;
                }
                var keyParts = includePathParts.slice(5),
                    includeName = includeInfo.includeName = getIncludeName(keyParts)
                if (!includeName) {
                    event("Include name template not found", includeInfo);
                    callback();
                    return;
                }
                includeTemplate = includesTemplate[includeName];
                if (!includeTemplate) {
                    event("Include template not found", includeInfo);
                    callback();
                    return;
                }
                switch (includeType) {
                    case "file":
                        propertyName = "content";
                        break;
                    case "command":
                        propertyName = "command";
                        break;
                }
                break;
            case "userdata":
                includeTemplate = resourceTemplate.Properties;
                if (!includeTemplate) {
                    event("Userdata template not found", includeInfo);
                    callback();
                    return;
                }
                if (text) {
                    var tag = includeInfo.userdataType;
                    if (tag) text = "<" + tag + ">\n" + text + "\n</" + tag + ">";
                }
                propertyName = "UserData";
                break;
        }
        parseIncludeText(includeInfo, includeTemplate, propertyName, text);
        callback();
    });

}

function getRegionNames(regionName, callback) {
    getEC2Client(regionName).describeRegions(function(error, result) {
        var regionNames;
        if (result) regionNames = result.Regions.map(function(o) { return o.RegionName; });
        event(error ? "Unable to retrieve region names" : "Retrieved region names", error ? { regionName: regionName } : { regionNames: regionNames }, error);
        callback(error, regionNames);
    });
}

function getTempatePaths(templatePathPatterns, callback) {
    if (!Array.isArray(templatePathPatterns) || templatePathPatterns.length === 0) templatePathPatterns = [ "./*.cloudformation" ];
    var toDo = templatePathPatterns.length,
        templatePaths = [];
    templatePathPatterns.forEach(function(templatePathPattern) {
        glob(templatePathPattern, function (error, result) {
            if (error) {
                event("Error retrieving template paths", { templatePathPattern: templatePathPattern }, error);
                return;
            }
            templatePaths.push.apply(templatePaths, result);
            if (--toDo === 0) {
                event("Template paths retrieved", { templatePaths: templatePaths });
                callback(null, templatePaths);
            }
        });
    });
}

function getFiles(directoryPath, callback) {
    recursiveReaddir(directoryPath, [ ".*" ], function(error, filePaths) {
        //need to support ignoring of windows system/hidden files here
        event(error ? "Unable to get files" : "Got files", { directoryPath: directoryPath, filePaths: filePaths }, error);
        callback(error, filePaths);
    });                
}

function processTemplate(templatePath, regionNames, callback) {
    var name = fspath.basename(templatePath),
        doSave = true;
    loadTemplate(templatePath, function (error, template) {
        if (error) return;
        var originalText = JSON.stringify(template),
            directoryPath = templatePath + ".d";
        getFiles(directoryPath, function(error, paths) {
            if (error) {
                return;
            }
            var filesToDo = paths.length,
                fileDone = function(error) {
                    if (error) doSave = false;
                    if ((--filesToDo === 0) && doSave) saveTemplate(template, originalText, templatePath, callback);
                };
            paths.forEach(function(path) {
                var parts = fspath.relative(directoryPath, path).split(fspath.sep);
                if (parts.length <= 1) {
                    event("File path not deep enough", { path: path });
                    fileDone();
                    return;
                }
                switch (parts[0]) {
                    case "mappings":
                        processMapping(name, template.Mappings, path, regionNames, fileDone);
                        break;
                    case "resources":
                        processInclude(name, template.Resources, path, parts, fileDone);
                        break;
                }
            });
        });
    });
}

function preProcess(regionName, templatePathPatterns, callback) {
    getRegionNames(regionName, function(error, regionNames) {
        if (error) return;
        getTempatePaths(templatePathPatterns, function(error, paths) {
            if (error) return;
            var toDo = paths.length;
            paths.forEach(function(path) {
                processTemplate(path, regionNames, function(error) {
                    if (--toDo === 0) {
                        event("Templates processed", { paths: paths });
                        callback(null, paths);
                    }
                });
            });
        });
    });
}

module.exports = preProcess;
