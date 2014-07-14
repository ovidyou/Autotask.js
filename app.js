//#Autotask Console
//
//Mainly used as a driver for the development of the autotask.js library.
//Eventually autotask.js should be used in a web-application for ease of access. 
//Not everyone will have the node runtime on their machine when making a time entry.
//
//*Based on https://www.autotask.net/help/content/Userguides/T_WebServicesAPIv1_5.pdf*
//
//**TODO LIST**
// - Handle errors.... 
// - Handle bad input.... (wrong username, password)
// - Allow entering non-task related time. (Vacation, etc.)
// - Allow the user to pick the Role and cache it for future use
// - Allow the user to pick the AllocationId and cache it for future use
// - Allow the user to delete his saved preferences
// - Obfuscate/Encrypt the UserName/Password when saving to disk
// - Extend for other department use.

	//Promise/A+ implementation. See: http://promises-aplus.github.io/promises-spec/
var when = require('when'), 
	//Autotask API wrapper
	autotask = require('./lib/autotask'), 
	//Read with a promise wrapper 
	read = require('./lib/readPromise'), 
	//File system access
	fs = require('fs'),
	//For printing pretty tables in the console
	Table = require('cli-table'),
	//For iterating over arrays/objects
	_ = require('lodash-node'); 

//Custom extensions for integrating with completers
require('./lib/cli-table-extensions');

process.on ("SIGINT", function(){
  //gracefully handle shutdown via Ctlr+C
  console.log('goodbye'.blue.inverse);
  process.exit ();
});


//The webservices URL to hit. 
//*TODO: This needs to be updated based on a call to: getZoneInfo()*
var url = 'https://webservices3.autotask.net/atservices/1.5/atws.wsdl';


//The preferences object to be written to disk
var m_prefs = {
	username: '', 
	password: ''
};

//*TODO:Can we get rid of these?*
//A time entry object
var m_timeEntry = {}; 
var m_resource = {}; 
var m_projTable = null; 

console.log('Press Ctrl+C to quit at any time.'.cyan.underline.inverse);

//Read the cached file containing the username/password
readFile('prefs.json')
.then(function (data) {
	//If we have the data, use it. If not we'll have to prompt the user to enter it.
	if(data){
		m_prefs = data; 
	}else{
		//Get the username
		return read({ prompt: 'Username: '})
		.then(function(input){
			m_prefs.username = input; 

			//Get the password
			return read({ prompt: 'Password: ', silent: true });
		})
		.then(function(input){
			m_prefs.password = input; 

			return when.promise(function(resolve, reject, notify){
				askQuestion(resolve, 'Would you like me to remember that (plain text storage)');
			}); 
		})
		.then(function (input) {
			//If they choose to remember then write the file out.
			if(input === '1'){
				return writeFile('prefs.json', m_prefs);
			}
		});
	}
})
.then(function(){

	console.log('Connecting...'.green.inverse);
	return autotask.connect(url, m_prefs.username, m_prefs.password); 
})
//Get information on our usage stats. 
.then(autotask.getThresholdAndUsageInfo) 
.then(function(data){
	console.log(data.yellow);

	//Get information about the user that logged in.
	return autotask.getResources(m_prefs.username); 
})
.then(function(resources){
	m_resource = resources && resources.length === 1 ? resources[0]: null;
	if(m_resource === null){
		console.log('Could not find that user.');
		process.exit(); 
	} 
	console.log(('Welcome ' + m_resource.FirstName).cyan.inverse);

	//Get the resource roles. 
	return autotask.getResourceRole(m_resource.id); 
})
.then(function(resourceRole){
	//*TODO: This is not returning a single role, but a collection of roles. *
	m_resource.RoleId = resourceRole.RoleID;

	console.log('loading SRS data...'.green.inverse);
	//Get SRS infomation so we can query for projects. 
	return autotask.getAccounts('SRS');
})
.then(function(accounts){
	console.log('loading [Dev-Eng] projects...'.green.inverse);

	//Enter main loop for entering time.
	return when.promise(function(resolve, reject, notify){
		timeEntryLoop(resolve, accounts);
	}); 

})
.then(function(){
	console.log('goodbye'.blue.inverse);
});

//##Time entry loop
//Iterate over this loop until the user is done entering his time.
function timeEntryLoop(resolve, accounts){

	//Get the available projects. This will be cached after the first hit.
	getProjects(accounts, m_projTable)
	.then(function(projects){
		m_projTable = projects;

		//Write out the resulting table
		console.log(m_projTable.toString()); 

		return read({ prompt: 'To make a time entry please enter an id from an above project: ', completer: m_projTable.getCompleter(0)});
	})
	.then(function (input) {
		//Get the task list based on the user's input
		return autotask.getTasks(input); 
	})
	.then(function(tasks){
		//*TODO: Handle no tasks returned*
		var taskArray = _.map(tasks, function(task) { return [task.id, task.Title]; });

		var table = new Table({ head: ['id', 'name'] });
		table.push.apply(table, taskArray);

		console.log(table.toString());

		return read({ prompt: 'To make a time entry please enter an id from an above task: ', completer: table.getCompleter(0)});
	})
	.then(function (taskId) {
		//Begin to build our time entry object. Not sure how to accomplish this without a global yet.
		//Perhaps we could pass the object into the asynchronous methods? 
		m_timeEntry = {}; 
		//The task ID we are going to add a time entry to
		m_timeEntry.taskId = taskId; 

		//Get the hours
		return when.promise(function(resolve, reject, notify){
			getHours(resolve);
		}); 
	})
	.then(function (hours) {
		//Add the hours to our time entry object
		m_timeEntry.hours = hours; 

		//Get the Comments
		return when.promise(function(resolve, reject, notify){
			getComment(resolve);
		}); 
	})
	.then(function (comment) {
		//Add the Comments to our time entry object
		m_timeEntry.comment = comment; 

		//*TODO: Get RoleId*
		return autotask.createTimeEntry(m_resource.id, null, m_timeEntry.hours, m_timeEntry.comment, m_timeEntry.taskId);
	}).
	then(function(result){
		//If we have a result then let the user know it was saved.
		if(result && result.createResult && result.createResult.ReturnCode === 1){
			console.log('saved'.green.inverse);
		}else{
			//Otherwise, let them know an error occurred. 
			console.log('Could not save due to error'.red.inverse);
		}

		//Ask if they'd like to make a second entry
		return when.promise(function(resolve, reject, notify){
			return askQuestion(resolve, 'Would you like to make a second entry');
		}); 
	}).then(function(input){
		//Yes
		if(input === '1'){
			//Re-enter time entry loop
			timeEntryLoop(resolve, accounts);
		}else{
			//No, then quit
			resolve();
		}
	});

}

//Get the [Dev-Eng] projects, but first check if we've already retrieved them
function getProjects(accounts, projectTable){
	return when.promise(function(resolve, reject, notify){
		
		if(projectTable){
			resolve(projectTable);
		}else{
			autotask.getProjects(accounts[0].id, '[Dev-Eng]')
			.then(function(projects){
				var projArray = _.map(projects, function(project) { return [project.id, project.ProjectName]; });

				projectTable = new Table({ head: ['id', 'name'] });
				projectTable.push.apply(projectTable, projArray);

				resolve(projectTable);
			});
		}
	}); 
}

//Prompts for hours and verifies they are correct, otherwise re-prompts.
function getHours(resolve){
	 read({ prompt: 'How much time did you spend: '})
	.then(function(input){
		var time = parseInt(input, 10);
		if(time > 0 && time <= 24){
			resolve(time); 
		}else{
			console.log('Time must be > 0 and <= 24');
			getHours(resolve);
		}
	});
}

//Prompts for comments and verifies they are correct, otherwise re-prompts.
function getComment(resolve){
	 read({ prompt: 'Please make a comment about your time entry: '})
	.then(function(input){
		if(input.trim() !== ''){
			resolve(input); 
		}else{
			console.log('Comments are not optional').
			getComment(resolve);
		}
	});
}

//Prompts with a Yes (1) or No (0) question and verifies if 1 or 0 was entered, otherwise re-prompts
function askQuestion(resolve, question){
	read({ prompt: question + '? [no:0,yes:1] '})
	.then(function(input){
		switch(input){
			case '0':
			case '1': 
				resolve(input);
				break;
			default: 
				console.log('Please enter 0 for no and 1 for yes.');
				askQuestion(resolve, question);
		}
	});
}

//Writes a object to disk
function writeFile(fname, obj){
	return when.promise(function(resolve, reject, notify){
		fs.writeFile(fname, JSON.stringify(obj), function(err) {
		    if(err) {
		        reject(err);
		    } else {
		        resolve(true);
		    }
		});
	}); 
}

//Reads an object from disk
function readFile(fname){
	return when.promise(function(resolve, reject, notify){
		fs.readFile(fname, 'utf8', function (err,data) {
			if(err) {
		        resolve(null);
		    } else {
		        resolve(JSON.parse(data));
		    }
		});
	}); 
}
