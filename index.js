var fs = require('fs');
var util = require('util');
var path = require('path');
var utils = require('./utils');
var parser = require('url');
var http = require('http');
var https = require('https');
var events = require('events');

var LENGTH_DIRECTORY = 9;
var LENGTH_HEADER = 2048;
var FILENAME_DB = 'config';
var FILENAME_CHANGELOG = 'changelog.log';
var EXTENSION = '.data';
var EXTENSION_TMP = '.tmp';
var JPEG = 'image/jpeg';
var PNG = 'image/png';
var GIF = 'image/gif';
var ENCODING = 'utf8';
var NEWLINE = '\r\n';
var NOTFOUND = '404: File not found.';
var BOUNDARY = '----' + Math.random().toString(16).substring(2);

function FileStorage(directory) {

	this.path = (directory || path.join(path.dirname(process.argv[1]), 'filestorage')).replace(/\\/g, '/');
	this.cache = {};
	this.options = {
		index: 0,
		count: 0
	};

	this.verification();
	this.onPrepare = function(filename, header, next) {
		next();
	};
}

FileStorage.prototype.__proto__ = Object.create(events.EventEmitter.prototype, {
	constructor: {
		value: FileStorage,
		enumberable: false
	}
});

FileStorage.prototype.verification = function() {

	var self = this;
	var options = self.options;

	self._mkdir(self.path, true);
	self._load();

	return self;
};

FileStorage.prototype._load = function() {

	var self = this;
	var options = self.options;
	var filename = path.join(self.path, FILENAME_DB);

	if (!fs.existsSync(filename))
		return self;

	var json = fs.readFileSync(filename, ENCODING).toString();
	if (json.length === 0)
		return self;

	var config = JSON.parse(json);

	options.index = config.index;
	options.count = config.count;

	return self;
};

FileStorage.prototype._save = function() {
	var self = this;
	var filename = path.join(self.path, FILENAME_DB);
	fs.writeFileSync(filename, JSON.stringify(self.options));
	return self;
};

FileStorage.prototype._append_changelog = function(id, description) {

	var self = this;

	if (typeof(id) === 'undefined')
		return self;

	if (typeof(description) === 'undefined')
		return self;

	var dd = new Date();

	var y = dd.getFullYear();
	var M = (dd.getMonth() + 1).toString();
	var d = dd.getDate().toString();
	var h = dd.getHours().toString();
	var m = dd.getMinutes().toString();
	var s = dd.getSeconds().toString();

	if (M.length === 1)
		M = '0' + M;

	if (d.length === 1)
		d = '0' + d;

	if (m.length === 1)
		m = '0' + m;

	if (h.length === 1)
		h = '0' + h;

	if (s.length === 1)
		s = '0' + s;

	var dt = y + '-' + M + '-' + d + ' ' + h + ':' + m + ':' + s;
	fs.appendFileSync(path.join(self.path, FILENAME_CHANGELOG), dt + ' - #' + id + ' ' + description + '\n');

	return self;
};

FileStorage.prototype._append = function(directory, value, id, eventname) {

	var self = this;
	var filename = directory + '/' + FILENAME_DB;

	var num = typeof(id) === 'number' ? id : parseInt(id, 10);

	if (eventname === 'insert') {
		fs.appendFileSync(filename, JSON.stringify(util._extend({
			id: num
		}, value)) + '\n');
		return self;
	}

	fs.readFile(filename, function(err, data) {

		var arr = err ? [] : data.toString('utf8').split('\n');
		var length = arr.length;
		var builder = [];
		var isHit = false;

		for (var i = 0; i < length; i++) {

			var line = arr[i];

			if (line.length < 1)
				continue;

			if (isHit) {
				builder.push(line);
				continue;
			}

			if (line.indexOf('"id":' + id + ',') !== -1) {
				if (eventname === 'update')
					builder.push(JSON.stringify(util._extend({
						id: num
					}, value)));

				isHit = true;
			} else
				builder.push(line);
		}

		fs.writeFileSync(filename, builder.join('\n') + '\n');
	});

	return self;
};

FileStorage.prototype._writeHeader = function(id, filename, header, fnCallback, type, directory) {

	var self = this;
	self.onPrepare(filename + EXTENSION_TMP, header, function() {
		fs.stat(filename + EXTENSION_TMP, function(err, stats) {

			if (!err)
				header.length = stats.size;

			header.stamp = new Date().getTime();

			var json = new Buffer(LENGTH_HEADER);
			json.fill(' ');
			json.write(JSON.stringify(header));

			var stream = fs.createWriteStream(filename + EXTENSION);
			stream.write(json, 'binary');

			var read = fs.createReadStream(filename + EXTENSION_TMP);
			read.pipe(stream);

			stream.on('finish', function() {
				fs.unlinkSync(filename + EXTENSION_TMP);

				if (fnCallback)
					fnCallback(null, id, header);

				self._append(directory, header, id.toString(), type);
				self.emit(type, id, header);
			});
		});
	});

	return self;
};

FileStorage.prototype._directory_index = function(index) {
	return Math.floor(index / 1000) + 1;
};

FileStorage.prototype._directory = function(index, isDirectory) {
	var self = this;
	var options = self.options;
	var id = (isDirectory ? index : self._directory_index(index)).toString().padLeft(LENGTH_DIRECTORY, '0');
	var length = id.length;
	var directory = '';

	for (var i = 0; i < length; i++)
		directory += (i % 3 === 0 && i > 0 ? '-' : '') + id[i];

	return path.join(self.path, directory);
};

FileStorage.prototype._mkdir = function(directory, noPath) {

	var self = this;
	var cache = self.cache;

	if (!noPath)
		directory = path.join(self.path, directory);

	var key = 'directory-' + directory;

	if (cache[key])
		return true;

	if (!fs.existsSync(directory))
		fs.mkdirSync(directory);

	cache[key] = true;
	return true;
};

/*
	Insert a file
	@name {String}
	@buffer {String, Stream, Buffer}
	@custom {String, Object} :: optional
	@fnCallback {Function} :: optional, params: @err {Error}, @id {Number}, @stat {Object}
	@change {String} :: optional, changelog
	return {Number} :: file id
*/
FileStorage.prototype.insert = function(name, buffer, custom, fnCallback, change, id) {

	var self = this;
	var options = self.options;

	if (typeof(buffer) === 'undefined') {
		var customError = new Error('Buffer is undefined.');
		self.emit('error', customError);
		fnCallback(customError, null, null);
		return;
	}

	if (typeof(custom) === 'function') {
		change = fnCallback;
		fnCallback = custom;
		custom = undefined;
	}

	var index = 0;
	var eventname = 'update';

	if (typeof(id) === 'undefined') {
		options.index++;
		index = options.index;
		eventname = 'insert';
		options.count++;
	} else
		index = utils.parseIndex(id);

	if (change)
		self._append_changelog(index, change);

	var directory = self._directory(index);

	self._mkdir(directory, true);

	name = path.basename(name);

	var filename = directory + '/' + index.toString().padLeft(LENGTH_DIRECTORY, '0');
	var stream = fs.createWriteStream(filename + EXTENSION_TMP);

	self._save();

	var ext = utils.extension(name);
	var header = {
		name: name,
		extension: ext,
		type: utils.contentType(ext),
		width: 0,
		height: 0,
		length: 0,
		custom: custom
	};

	if (typeof(buffer) === 'string') {
		if (buffer.length % 4 === 0 && buffer.match(/^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/) !== null)
			buffer = new Buffer(buffer, 'base64');
		else
			buffer = fs.createReadStream(buffer.replace(/\\/g, '/'));
	}

	var isBuffer = typeof(buffer.pipe) === 'undefined';
	var size = null;

	if (isBuffer) {

		if (header.type === JPEG) {
			size = utils.dimensionJPG(buffer);
			if (size) {
				header.width = size.width;
				header.height = size.height;
			}
		} else if (header.type === PNG) {
			size = utils.dimensionPNG(buffer);
			if (size) {
				header.width = size.width;
				header.height = size.height;
			}
		} else if (header.type === GIF) {
			size = utils.dimensionGIF(buffer);
			if (size) {
				header.width = size.width;
				header.height = size.height;
			}
		}

		stream.on('finish', function() {
			self._writeHeader(index, filename, header, fnCallback, eventname, directory);
		});

		stream.end(buffer);
		return index;
	}

	buffer.pipe(stream);

	if (header.type === JPEG || header.type === PNG || header.type === GIF) {

		buffer.on('data', function onData(chunk) {

			if (size !== null) {
				buffer.removeListener('data', onData);
				return;
			}

			if (header.type === JPEG) {
				size = utils.dimensionJPG(chunk);

				if (size === null)
					return;

				header.width = size.width;
				header.height = size.height;
				return;
			}

			if (header.type === PNG) {
				size = utils.dimensionPNG(chunk);
				header.width = size.width;
				header.height = size.height;
				return;
			}

			if (header.type === GIF) {
				size = utils.dimensionGIF(chunk);
				header.width = size.width;
				header.height = size.height;
				return;
			}

		});
	}

	stream.on('finish', function() {
		self._writeHeader(index, filename, header, fnCallback, eventname, directory);
	});

	return index;
};

/*
	Update a file
	@id {String or Number}
	@name {String}
	@buffer {String, Stream, Buffer}
	@custom {String, Object} :: optional
	@fnCallback {Function} :: optional, params: @err {Error}, @id {Number}, @stat {Object}
	@change {String} :: optional, changelog
	return {Number}
*/
FileStorage.prototype.update = function(id, name, buffer, custom, fnCallback, change) {
	if (typeof(name) === 'function')
		return this.update_header(id, name, buffer);
	return this.insert(name, buffer, custom, fnCallback, change, id);
};

/*
	Change header informations
	@id {String or Number}
	@fnCallback {Function(err, header)} :: must return a new header.
	return {Object}
 */
FileStorage.prototype.update_header = function(id, fnCallback, change) {

	var self = this;
	var index = utils.parseIndex(id);

	if (change)
		self._append_changelog(index, change);

	self.stat(id, function(err, stat, filename) {
		if (err)
			return fnCallback(err, null);
		var header = fnCallback(null, stat);
		if (!header)
			return;
		var writer = fs.createWriteStream(filename, { start: 0, flags: 'r+' });
		var json = new Buffer(LENGTH_HEADER);
		json.fill(' ');
		json.write(JSON.stringify(header));
		writer.end(json);
	});

	return self;
};

/*
	Remove a file
	@id {String or Number}
	@fnCallback {Function} :: optional, params: @err {Error}
	@change {String} :: optional, changelog
	return {FileStorage}
*/
FileStorage.prototype.remove = function(id, fnCallback, change) {

	var self = this;

	if (id === 'change' || id === 'changelog') {
		fs.unlink(path.join(self.path, FILENAME_CHANGELOG), function(err) {
			if (fnCallback)
				fnCallback(err);
		});
		return self;
	}

	var index = utils.parseIndex(id.toString());
	var directory = self._directory(index);
	var filename = directory + '/' + index.toString().padLeft(LENGTH_DIRECTORY, '0') + EXTENSION;

	if (typeof(fnCallback) === 'string') {
		var tmp = change;
		change = fnCallback;
		fnCallback = tmp;
	}

	if (change)
		self._append_changelog(index, change);

	fs.unlink(filename, function(err) {

		if (!err) {
			self.options.count--;
			self.emit('remove', id);
			self._append(directory, null, index.toString(), 'remove');
			self._save();
		} else
			self.emit('error', err);

		if (fnCallback)
			fnCallback(err !== null ? err.errno === 34 ? new Error(NOTFOUND) : err : null);

	});

	return self;
};

/*
	A file information
	@id {String or Number}
	@fnCallback {Function} :: params: @err {Error}, @stat {Object}
	return {FileStorage}
*/
FileStorage.prototype.stat = function(id, fnCallback) {

	var self = this;
	var index = utils.parseIndex(id.toString());
	var directory = self._directory(index);
	var filename = directory + '/' + index.toString().padLeft(LENGTH_DIRECTORY, '0') + EXTENSION;
	var data = [];

	var stream = fs.createReadStream(filename, {
		start: 0,
		end: LENGTH_HEADER - 1
	});

	stream.once('data', function(chunk){
		data.push(chunk);
	});

	stream.once('end', function() {
		var buffer = Buffer.concat(data);
		try {
			fnCallback(null, JSON.parse(buffer.toString(ENCODING).replace(/^[\s]+|[\s]+$/g, '')), filename);
		} catch(err) {
			fnCallback(err, null);
		}
	});

	stream.once('error', function(err) {
		self.emit('error', err);
		fnCallback(err.errno === 34 ? new Error(NOTFOUND) : err, null);
	});

	return self;
};

/*
	Send a file through HTTP
	@id {String or Number}
	@url {String}
	@fnCallback {Function} :: optional, params: @err {Error}, @response {String}
	@headers {Object} :: optional, additional headers
	return {FileStorage}
*/
FileStorage.prototype.send = function(id, url, fnCallback, headers) {

	var self = this;

	if (typeof(fnCallback) === 'object') {
		var tmp = headers;
		fnCallback = headers;
		headers = tmp;
	}

	self.stat(id, function(err, stat, filename) {

		if (err) {
			self.emit('error', err);
			fnCallback(err, null);
			return;
		}

		var h = {};

		if (headers)
			util._extend(h, headers);

		h['Cache-Control'] = 'max-age=0';
		h['Content-Type'] = 'multipart/form-data; boundary=' + BOUNDARY;

		var options = parser.parse(url);

		options.agent = false;
		options.method = 'POST';
		options.headers = h;

		var response = function(res) {
			res.body = '';

			res.on('data', function(chunk) {
				this.body += chunk.toString(ENCODING);
			});

			res.on('end', function() {
				fnCallback(null, res.body);
				self.emit('send', id, stat, url);
			});
		};

		var connection = options.protocol === 'https:' ? https : http;
		var req = connection.request(options, response);

		req.on('error', function(err) {
			self.emit('error', err);
			fnCallback(err, null);
		});

		var header = NEWLINE + NEWLINE + '--' + BOUNDARY + NEWLINE + 'Content-Disposition: form-data; name="File"; filename="' + stat.name + '"' + NEWLINE + 'Content-Type: ' + stat.type + NEWLINE + NEWLINE;
		req.write(header);

		var stream = fs.createReadStream(filename, {
			start: LENGTH_HEADER
		});

		stream.on('end', function() {
			req.end(NEWLINE + NEWLINE + '--' + BOUNDARY + '--');
		});

		stream.pipe(req, {
			end: false
		});
	});

	return self;
};

/*
	Copy file
	@id {String or Number}
	@directory {String}
	@fnCallback {Function} :: params: @err {Error}
	@name {String} :: optional, new filename
	return {FileStorage}
*/
FileStorage.prototype.copy = function(id, directory, fnCallback, name) {

	var self = this;

	if (typeof(fnCallback) === 'string') {
		var tmp = name;
		name = fnCallback;
		fnCallback = tmp;
	}

	self.stat(id, function(err, stat, filename) {

		if (err) {
			self.emit('error', err);
			fnCallback(err);
			return;
		}

		if (typeof(name) === 'undefined')
			name = stat.name;

		var stream = fs.createReadStream(filename, {
			start: LENGTH_HEADER
		});
		self.emit('copy', id, stat, stream, directory);

		var writer = fs.createWriteStream(path.join(directory, name));
		stream.pipe(writer);

		if (!fnCallback)
			return;

		stream.on('end', function() {
			fnCallback(null);
		});
	});

	return self;
};

/*
	Read a file
	@id {String or Number}
	@fnCallback {Function} :: params: @err {Error}, @stream {ReadStream}, @stat {Object}
	return {FileStorage}
*/
FileStorage.prototype.read = function(id, fnCallback) {

	var self = this;

	self.stat(id, function(err, stat, filename) {

		if (err) {
			self.emit('error', err);
			fnCallback(err, null);
			return;
		}

		var stream = fs.createReadStream(filename, {
			start: LENGTH_HEADER
		});

		self.emit('read', id, stat, stream);
		fnCallback(null, stream, stat);

	});

	return self;
};

FileStorage.prototype.read_header = function(id, fnCallback) {

	var self = this;

	self.stat(id, function(err, stat, filename) {

		if (err) {
			self.emit('error', err);
			fnCallback(err, null);
			return;
		}



	});

	return self;
};

/*
	Get all file names
	@fnCallback {Function} :: params: @err {Error}, @arr {String Array}
	return {FileStorage}
*/
FileStorage.prototype.listing = function(fnCallback) {

	var self = this;
	var max = self._directory_index(self.options.index);
	var directory = [];
	var builder = [];

	for (var i = 1; i <= max; i++)
		directory.push(self._directory(i, true));

	function config() {

		var filename = directory.shift();

		if (typeof(filename) === 'undefined') {
			self.emit('listing', builder);
			fnCallback(null, builder);
			return;
		}

		fs.readFile(path.join(filename, FILENAME_DB), function(err, data) {

			if (err)
				self.emit('error', err);
			else
				builder.push(data.toString('utf8').trim());

			config();
		});
	}

	config();
	return self;
};

/*
	Pipe a stream to Stream or HttpResponse
	@id {String or Number}
	@req {HttpRequest} :: optional
	@res {HttpResponse or Stream}
	@download {String or Boolean} :: optional, attachment - if string filename is download else if boolean filename will a stat.name
	return {FileStorage}
*/
FileStorage.prototype.pipe = function(id, req, res, download) {

	var self = this;

	var isResponse = res && res.writeHead !== undefined;
	self.stat(id, function(err, stat, filename) {

		if (err) {

			if (isResponse) {
				res.success = true;
				res.writeHead(404, {
					'Content-Type': 'text/plain'
				});
				res.end(NOTFOUND);
				return;
			}

			throw err;
		}

		if (!isResponse) {
			self.emit('pipe', id, stat, fs.createReadStream(filename, {
				start: LENGTH_HEADER
			}).pipe(req), req);
			return;
		}

		var beg = 0;
		var end = 0;
		var length = stat.length;
		var isRange = false;
		var expires = new Date();
		expires.setMonth(expires.getMonth() + 15);

		var headers = {
			'Content-Type': stat.type,
			'Etag': stat.stamp,
			'Last-Modified': new Date(stat.stamp).toUTCString(),
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'public, max-age=11111111',
			'Expires': expires,
			'X-Powered-By': 'node.js FileStorage',
			'Vary': 'Accept-Encoding',
			'Access-Control-Allow-Origin': '*'
		};

		if (req) {

			if (req.headers['if-none-match'] === stat.stamp.toString()) {
				res.success = true;
				res.writeHead(304, headers);
				res.end();
				return;
			}

			var range = req.headers['range'] || '';

			if (range.length > 0) {

				var arr = range.replace(/bytes=/, '').split('-');
				beg = parseInt(arr[0] || '0', 10);
				end = parseInt(arr[1] || '0', 10);
				isRange = true;

				if (end === 0)
					end = length - 1;

				if (beg > end) {
					beg = 0;
					end = length - 1;
				}

				length = (end - beg) + 1;
			}
		}

		headers['Content-Length'] = length;

		if (stat.width > 0)
			headers['X-Image-Width'] = stat.width;
		if (stat.height > 0)
			headers['X-Image-Height'] = stat.height;

		if (typeof(download) === 'string')
			headers['Content-Disposition'] = 'attachment; filename=' + encodeURIComponent(download);
		else if (download === true)
			headers['Content-Disposition'] = 'attachment; filename=' + encodeURIComponent(stat.name);

		var options = {
			start: LENGTH_HEADER
		};

		if (end === 0)
			end = length - 1;

		if (beg > end) {
			beg = 0;
			end = length - 1;
		}

		if (beg > 0)
			options.start += beg;

		if (end > 0)
			options.end = end + options.start;


		if (beg > 0 || end > 0)
			headers['Content-Range'] = 'bytes ' + beg + '-' + end + '/' + stat.length;

		res.writeHead(isRange ? 206 : 200, headers);
		self.emit('pipe', id, stat, fs.createReadStream(filename, options).pipe(res));

	});

	return self;
};

/*
	Read the changelog
	@fnCallback {Function} :: params: @err {Error}, @changes {String Array}
	return {FileStorage}
*/
FileStorage.prototype.changelog = function(fnCallback) {

	var self = this;
	var stream = fs.createReadStream(path.join(self.path, FILENAME_CHANGELOG));

	stream._changedata = '';

	stream.on('data', function(chunk) {
		this._changedata += chunk.toString('utf8');
	});

	stream.on('error', function(err) {
		fnCallback(err, null);
	});

	stream.on('end', function() {
		var data = this._changedata.split('\n');
		self.emit('changelog', data);
		fnCallback(null, data);
	});

	return self;
};

exports.create = function(path) {
	var storage = new FileStorage(path);
	storage.on('error', function() {});
	return storage;
};
