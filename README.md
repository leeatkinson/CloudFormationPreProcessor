CloudFormation PreProcessor
===========================

A pre-processsor for AWS CloudFormation. 

Features
--------
* Update to the current AMIs - for example, the 'latest' Windows 2012 AMI from Amazon. 'Latest' is determined by sorting their names alphabetically and selecting the last.
* Include files to be copied to instances via CFN-init. 

Preparation
-----------

Create your CloudFormation template as normal. Make sure that AMI mappings in the Mappings template section are of the format:

```json
{
    ...
    "Mappings": {
        ...
        "<mapping-name>": {
            "us-west-1": { "ID": "<ami-id>" },
            "ap-southeast-1": { "ID": "<ami-id>" },
            ...
        },
    ...
}
```

Create a JSON file who's file path is the same as template but has an extra file extension. For example:

* Template = /Users/lee/Documents/MyTemplate.cloudformation
* Config = /Users/lee/Documents/MyTemplate.cloudformation.&lt;whatever&gt;

The format of the config file is:

```json
{
    "amiMappings": {
        "<mapping-name>": {
            "amiName": "Windows_Server-2012-RTM-English-64Bit-Base*"
        }
    },
    "fileIncludes": {
        "directory": "<relative-path-of-files>",
        "resources": {
            "<instance-or-launchconfig-name>": {
                "config|<configset-name>": {
                    "/directory/foo.txt": "bar.txt"
                }
            }
        }
    }
}
```
The file to include (in the above case, bar.txt) is located relative to the fileIncludes' 'directory' path, which in turn is relative to the template file.

Execution
---------

You can execute cfnpp without any arguments, and it will pre-process templates using any configuration files with .cfnpp extensions. 

```bash
cfnpp
```

If you are using a different file extension for your configuration files, use the -f or --config-file-pattern argument.

```bash
cfnpp -f *.preprocessconfig
```
