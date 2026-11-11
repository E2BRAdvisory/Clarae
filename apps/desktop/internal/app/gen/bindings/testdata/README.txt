golden/    what `wails generate module` (Wails v2.17.1) writes for the services of ../fixture, one file per
           file of packages/workbench/wailsjs, with a .golden suffix (keeps eslint and prettier out).
           generate_test.go requires the generator to write exactly these files.
regen-golden.sh   rewrites golden/ with the Wails CLI; run it only to extend the fixture and review the diff.
