const path = require('path');
const nodeExternals = require('webpack-node-externals');
var WebpackObfuscator = require('webpack-obfuscator');

module.exports = {
    target: "node",
    entry: {
        app: ["./src/index.ts"]
    },
    // Remove following comments. For some reason, binary is not getting pkg'd with this
    // plugins: [
    //     new WebpackObfuscator({
    //         rotateStringArray: true
    //     })
    // ],
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                enforce: 'post',
                use: [
                    'ts-loader'
                ],
                exclude: /node_modules/
            },
            {
                test: /\.js$/,
                exclude: [
                    path.resolve(__dirname, 'excluded_file_name.js')
                ],
                enforce: 'post',
                use: {
                    loader: WebpackObfuscator.loader,
                    options: {
                        rotateStringArray: true
                    }
                }
            }
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "bundle.js"
    },
    externals: [nodeExternals()],
};
