CloudFormation PreProcessor
===========================

A pre-processsor for AWS CloudFormation. Currently, it is able to update to the current AMIs (e.g. the 'latest' Windows 2012 AMI from Amazon) and include files to be copied to instances via CFN-init. The definition of 'latest' is defined by sorting their names alphabetically and selecting the last. 

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

Template = /Users/lee/Documents/MyTemplate.cloudformation
Config = /Users/lee/Documents/MyTemplate.cloudformation.<whatever>

The format of the config file is:

```json
{
    "amiMappings": {
        "<mapping-name>": {
            "amiName": "Windows_Server-2012-RTM-English-64Bit-Base*"
        }
    },
    "fileIncludes": {
        "<instance-or-launchconfig-name>": {
            "config|<configset-name>": {
                "/directory/foo.txt": "bar.txt"
            }
        }
    }
}
```
The file to include (in the above case, bar.txt) is located relative to the template file (in the above case, bar.txt should be located in the same dirctory as the template).

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
